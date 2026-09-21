const { BrowserWindow, app } = require('electron');
const { PDFDocument, degrees } = require('pdf-lib');
const { print } = require('pdf-to-printer');
const fs = require('fs/promises');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const SUPPORTED = new Set(['.pdf','.html','.htm','.doc','.docx','.xls','.xlsx','.png','.jpg','.jpeg']);
const PAPER = {
  A4: { width: 595.276, height: 841.89, kind: 9 },
  A5: { width: 419.528, height: 595.276, kind: 11 }
};

function extensionOf(filePath) { return path.extname(filePath).toLowerCase(); }
function isSupported(filePath) { return SUPPORTED.has(extensionOf(filePath)); }

async function makeJobDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'a4-a5-print-'));
}

async function mergePdfPagesVertically(bytes) {
  const source = await PDFDocument.load(bytes);
  if (source.getPageCount() <= 1) return bytes;
  const pages = source.getPages();
  const result = await PDFDocument.create();
  const embedded = await result.embedPages(pages);
  const width = Math.max(...pages.map(page => page.getWidth()));
  const height = pages.reduce((sum,page) => sum + page.getHeight(), 0);
  const target = result.addPage([width,height]);
  let top = height;
  embedded.forEach((page,index) => {
    const size = pages[index].getSize();
    top -= size.height;
    target.drawPage(page,{ x:(width-size.width)/2, y:top, width:size.width, height:size.height });
  });
  return result.save({ useObjectStreams:true });
}

async function printSinglePageHtmlNative(inputPath,options,onProgress) {
  const startedAt=Date.now();
  const timings={};
  const window = new BrowserWindow({ show:false, webPreferences:{ sandbox:true, javascript:true } });
  let debuggerAttached = false;
  let temporarySpoolPath = null;
  let diagnosticWritePromise = Promise.resolve();
  try {
    await window.loadFile(inputPath);
    await window.webContents.executeJavaScript(`Promise.all([
      document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
      ...[...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
        image.addEventListener('load', resolve, { once:true });
        image.addEventListener('error', resolve, { once:true });
      })),
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve,150))))
    ])`);
    timings.loadHtmlMs=Date.now()-startedAt;

    const isA5 = options.targetSize === 'A5';
    if (isA5) {
      try {
        window.webContents.debugger.attach('1.3');
        debuggerAttached = true;
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{media:'print'});
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      } catch {}
    }
    const base = isA5 ? { widthMm:148, heightMm:210 } : { widthMm:210, heightMm:297 };
    const prepareStartedAt=Date.now();
    const prepared = await window.webContents.executeJavaScript(`(() => {
      const base = ${JSON.stringify(base)};
      const useFullBounds = ${isA5};
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const pages = [...document.querySelectorAll('.page, [data-print-page]')].filter(visible);
      const forcedBreak = [...document.querySelectorAll('body *')].some(element => {
        if (!visible(element)) return false;
        const style = getComputedStyle(element);
        return ['page','always','left','right','recto','verso'].includes(style.breakBefore) ||
          ['page','always','left','right','recto','verso'].includes(style.pageBreakBefore);
      });
      if (pages.length > 1 || forcedBreak) return { handled:false };

      let page = pages[0];
      if (!page) {
        page = document.createElement('div');
        page.id = '__native_html_content__';
        while (document.body.firstChild) page.appendChild(document.body.firstChild);
        document.body.appendChild(page);
      }
      const rect = page.getBoundingClientRect();
      const naturalWidth = Math.max(rect.width,page.scrollWidth,page.offsetWidth,1);
      const naturalHeight = Math.max(rect.height,page.scrollHeight,page.offsetHeight,1);
      if (useFullBounds) page.style.setProperty('overflow','visible','important');
      const boxes = useFullBounds ? [...page.querySelectorAll('*')].filter(element =>
        visible(element) && !element.matches('.no-print,.menu-fix,.break-page,script,style,template')
      ).map(element => element.getBoundingClientRect()) : [];
      const minLeft = boxes.length ? Math.min(...boxes.map(box=>box.left)) : rect.left;
      const minTop = boxes.length ? Math.min(...boxes.map(box=>box.top)) : rect.top;
      const maxRight = boxes.length ? Math.max(...boxes.map(box=>box.right)) : rect.left+naturalWidth;
      const maxBottom = boxes.length ? Math.max(...boxes.map(box=>box.bottom)) : rect.top+naturalHeight;
      const contentLeft = minLeft-rect.left;
      const contentTop = minTop-rect.top;
      const contentWidth = Math.max(maxRight-minLeft,1);
      const contentHeight = Math.max(maxBottom-minTop,1);
      const landscape = contentWidth > contentHeight;
      const rotateInsideA5 = useFullBounds && landscape;
      const widthMm = useFullBounds ? base.widthMm : (landscape ? base.heightMm : base.widthMm);
      const heightMm = useFullBounds ? base.heightMm : (landscape ? base.widthMm : base.heightMm);
      const widthPx = widthMm*96/25.4;
      const heightPx = heightMm*96/25.4;
      const sideMargin = 7*96/25.4;
      const verticalMargin = (useFullBounds ? 3 : 5)*96/25.4;
      const printableWidth = widthPx-sideMargin*2;
      const printableHeight = heightPx-verticalMargin*2;
      const fittedWidth = rotateInsideA5 ? contentHeight : contentWidth;
      const fittedHeight = rotateInsideA5 ? contentWidth : contentHeight;
      const scale = Math.min(printableWidth/fittedWidth,printableHeight/fittedHeight);
      const shell = document.createElement('section');
      shell.id = '__native_html_sheet__';
      page.style.setProperty('position','absolute','important');
      page.style.setProperty('box-sizing','border-box','important');
      page.style.setProperty('width',naturalWidth+'px','important');
      page.style.setProperty('min-width','0','important');
      page.style.setProperty('height',naturalHeight+'px','important');
      page.style.setProperty('min-height','0','important');
      page.style.setProperty('max-width','none','important');
      page.style.setProperty('max-height','none','important');
      page.style.setProperty('margin','0','important');
      page.style.setProperty('break-before','auto','important');
      page.style.setProperty('break-after','auto','important');
      page.style.setProperty('page-break-before','auto','important');
      page.style.setProperty('page-break-after','auto','important');
      page.style.setProperty('transform-origin','top left','important');
      if (rotateInsideA5) {
        const targetLeft=sideMargin+(printableWidth-contentHeight*scale)/2;
        const targetTop=verticalMargin;
        const translateX=targetLeft+(contentTop+contentHeight)*scale;
        const translateY=targetTop-contentLeft*scale;
        page.style.setProperty('left','0','important');
        page.style.setProperty('top','0','important');
        page.style.setProperty('transform','translate('+translateX+'px,'+translateY+'px) rotate(90deg) scale('+scale+')','important');
      } else {
        page.style.setProperty('transform','scale('+scale+')','important');
        page.style.setProperty('left',(sideMargin+(printableWidth-contentWidth*scale)/2-contentLeft*scale)+'px','important');
        page.style.setProperty('top',((useFullBounds ? verticalMargin : verticalMargin+(printableHeight-contentHeight*scale)/2)-contentTop*scale)+'px','important');
      }
      shell.appendChild(page);
      document.body.replaceChildren(shell);
      const style = document.createElement('style');
      style.textContent = '@page{size:'+(useFullBounds ? 'A5' : widthMm+'mm '+heightMm+'mm')+';margin:0}' +
        'html,body{margin:0!important;padding:0!important;width:'+widthMm+'mm!important;height:'+heightMm+'mm!important;overflow:hidden!important;background:#fff!important}' +
        '#__native_html_sheet__{position:relative!important;display:block!important;width:'+widthMm+'mm!important;height:'+heightMm+'mm!important;margin:0!important;padding:0!important;overflow:hidden!important}';
      document.head.appendChild(style);
      return {
        handled:true,
        landscape,
        driverLandscape:useFullBounds ? false : landscape,
        diagnostic:{
          contentWidth:Math.round(contentWidth*100)/100,
          contentHeight:Math.round(contentHeight*100)/100,
          scale:Math.round(scale*10000)/10000,
          rotateInsideA5,
          cssPage:widthMm+'x'+heightMm,
          topMarginPx:Math.round(verticalMargin*100)/100
        }
      };
    })()`);

    if (!prepared.handled) return { handled:false };
    await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
    timings.prepareHtmlMs=Date.now()-prepareStartedAt;
    let diagnosticPath = null;
    if (isA5) {
      const convertStartedAt=Date.now();
      const diagnosticDir=path.join(app.getPath('documents'),'A4-A5-Printer-Debug');
      diagnosticPath=path.join(diagnosticDir,'A5-preview-latest.pdf');
      const previewBytes=await window.webContents.printToPDF({
        printBackground:true,
        preferCSSPageSize:true,
        pageSize:'A5',
        landscape:false,
        margins:{top:0,bottom:0,left:0,right:0}
      });
      const spoolDir=path.join(app.getPath('temp'),'a4-a5-printer-spool');
      await fs.mkdir(spoolDir,{recursive:true});
      temporarySpoolPath=path.join(spoolDir,`A5-${crypto.randomUUID()}.pdf`);
      await fs.writeFile(temporarySpoolPath,previewBytes);
      timings.convertPdfMs=Date.now()-convertStartedAt;
      // Documents can be redirected to OneDrive or scanned by antivirus.
      // Preserve the debug files, but write them in parallel with printing so
      // that this optional I/O never delays submission to the spooler.
      diagnosticWritePromise=(async()=>{
        await fs.mkdir(diagnosticDir,{recursive:true});
        await Promise.all([
          fs.writeFile(diagnosticPath,previewBytes),
          fs.writeFile(path.join(diagnosticDir,'A5-preview-latest.json'),JSON.stringify(prepared.diagnostic,null,2),'utf8')
        ]);
      })().catch(error=>{
        diagnosticPath=null;
        onProgress(`Cảnh báo: không lưu được file kiểm tra A5 (${error.message})`);
      });
    }
    if (isA5) {
      // Some printer drivers add their imageable-area offset again when
      // Chromium prints HTML directly. Print the already-correct A5 PDF so
      // the physical output uses exactly the same layout as the preview.
      onProgress('Đang gửi PDF A5 đã scale chuẩn tới Windows Print Spooler...');
      const spoolStartedAt=Date.now();
      await print(temporarySpoolPath,{
        printer:options.deviceName,
        paperSize:'A5',
        paperKind:PAPER.A5.kind,
        scale:'noscale',
        monochrome:options.color === false,
        copies:Math.max(1,Number(options.copies)||1),
        silent:true
      });
      timings.spoolMs=Date.now()-spoolStartedAt;
      await diagnosticWritePromise;
      const spoolFile=temporarySpoolPath;
      const cleanup=setTimeout(()=>fs.unlink(spoolFile).catch(()=>{}),60000);
      cleanup.unref();
      temporarySpoolPath=null;
    } else {
      onProgress('Đang gửi trực tiếp HTML 1 trang tới driver máy in...');
      const spoolStartedAt=Date.now();
      await new Promise((resolve,reject) => {
        window.webContents.print({
          silent:true,
          deviceName:options.deviceName,
          printBackground:true,
          color:options.color !== false,
          copies:Math.max(1,Number(options.copies)||1),
          landscape:prepared.driverLandscape,
          scaleFactor:100,
          margins:{ marginType:'none' },
          pageSize:options.targetSize
        },(success,failureReason) => success ? resolve() : reject(new Error(failureReason || 'Driver từ chối lệnh in HTML')));
      });
      timings.spoolMs=Date.now()-spoolStartedAt;
      // The callback means Chromium has handed the job to the driver. A short
      // settle avoids destroying the hidden page in the same event-loop tick.
      await new Promise(resolve => setTimeout(resolve,200));
    }
    timings.totalPipelineMs=Date.now()-startedAt;
    return { handled:true,ok:true,pages:1,targetSize:options.targetSize,orientation:prepared.landscape?'landscape':'portrait',diagnosticPath,timings };
  } finally {
    if (temporarySpoolPath) {
      try { await fs.unlink(temporarySpoolPath); } catch {}
    }
    if (debuggerAttached) {
      try { window.webContents.debugger.detach(); } catch {}
    }
    window.destroy();
  }
}

async function htmlToPdf(inputPath, outputPath, targetSize, streamOptions=null) {
  const window = new BrowserWindow({ show:false, webPreferences:{ sandbox:true, javascript:true } });
  let debuggerAttached = false;
  try {
    await window.loadFile(inputPath);
    await window.webContents.executeJavaScript(`Promise.all([
      document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
      ...[...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
        image.addEventListener('load', resolve, { once:true });
        image.addEventListener('error', resolve, { once:true });
      })),
      new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 150))))
    ])`);

    const layout = await window.webContents.executeJavaScript(`(() => {
      const visible = element => {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
      };
      const pageNodes = [...document.querySelectorAll('.page, [data-print-page]')].filter(visible);
      const forcedBreaks = [...document.querySelectorAll('body *')].filter(element => {
        if (!visible(element)) return false;
        const style = getComputedStyle(element);
        return ['page','always','left','right','recto','verso'].includes(style.breakBefore) ||
          ['page','always','left','right','recto','verso'].includes(style.pageBreakBefore);
      });
      if (${Boolean(streamOptions)} && pageNodes.length > 1) window.__a4a5SourcePages=pageNodes;
      return { pageCount:pageNodes.length, hasExplicitPagination:pageNodes.length > 1 || forcedBreaks.length > 0 };
    })()`);

    if (layout.hasExplicitPagination) {
      try {
        window.webContents.debugger.attach('1.3');
        debuggerAttached = true;
      } catch {}
      const target = targetSize === 'A5'
        ? { widthMm:148, heightMm:210, widthPx:148*96/25.4, heightPx:210*96/25.4, sideMarginMm:7 }
        : { widthMm:210, heightMm:297, widthPx:210*96/25.4, heightPx:297*96/25.4, sideMarginMm:10 };
      const combined = streamOptions ? null : await PDFDocument.create();
      const pageDiagnostics = [];
      const pageIndices = streamOptions
        ? streamOptions.getPageIndices(layout.pageCount)
        : Array.from({length:layout.pageCount},(_value,index)=>index);

      for (let sequenceIndex=0; sequenceIndex<pageIndices.length; sequenceIndex += 1) {
        const pageIndex=pageIndices[sequenceIndex];
        if (streamOptions && streamOptions.onBeforePage) {
          await streamOptions.onBeforePage({pageIndex,sourcePageCount:layout.pageCount,sequenceIndex,sequenceCount:pageIndices.length});
        }
        if (sequenceIndex > 0 && !streamOptions) {
          await window.loadFile(inputPath);
          await window.webContents.executeJavaScript(`Promise.all([
            document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve(),
            ...[...document.images].map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
              image.addEventListener('load', resolve, { once:true });
              image.addEventListener('error', resolve, { once:true });
            })),
            new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve,${targetSize === 'A4' ? 50 : 150}))))
          ])`);
        } else if (sequenceIndex > 0) {
          await window.webContents.executeJavaScript(`(() => {
            const page=window.__a4a5SourcePages && window.__a4a5SourcePages[${pageIndex}];
            if (!page) throw new Error('Không tìm thấy trang HTML số ${pageIndex+1} trong bộ nhớ');
            document.body.replaceChildren(page);
          })()`);
        }
        if (debuggerAttached) {
          try {
            await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{ media:'print' });
          } catch {}
        }
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        if (targetSize === 'A4') {
          // Một số mẫu dựng bảng/canvas sau khi load xong. Chờ hình học trang
          // ổn định để không lấy kích thước quá sớm rồi cắt phần bên phải.
          await window.webContents.executeJavaScript(`new Promise(resolve => {
            let previous='';
            let stableRounds=0;
            let attempts=0;
            const sample=()=>{
              const pages=[...document.querySelectorAll('.page,[data-print-page]')];
              const signature=pages.map(page=>{
                const rect=page.getBoundingClientRect();
                return [rect.left,rect.top,rect.width,rect.height,page.scrollWidth,page.scrollHeight].map(value=>Math.round(value*10)/10).join(':');
              }).join('|');
              stableRounds=signature===previous ? stableRounds+1 : 0;
              previous=signature;
              attempts+=1;
              if (stableRounds>=2 || attempts>=10) resolve();
              else setTimeout(sample,50);
            };
            sample();
          })`);
        }
        const pageDiagnostic = await window.webContents.executeJavaScript(`(() => {
          const target = ${JSON.stringify(target)};
          const pageIndex = ${pageIndex};
          const visible = element => {
            const style=getComputedStyle(element);
            const rect=element.getBoundingClientRect();
            return style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)!==0 && rect.width>0 && rect.height>0;
          };
          const pages=window.__a4a5SourcePages || [...document.querySelectorAll('.page,[data-print-page]')].filter(visible);
          const page=pages[pageIndex];
          if (!page) throw new Error('Không tìm thấy trang HTML số '+(pageIndex+1));

          const genericStyle=document.createElement('style');
          genericStyle.textContent='.no-print,.menu-fix,.break-page{display:none!important}' +
            '.__isolated_source_page__,.__isolated_source_page__ *{overflow:visible!important}' +
            '@page{size:'+target.widthMm+'mm '+target.heightMm+'mm;margin:0}';
          document.head.appendChild(genericStyle);

          const initialPageRect=page.getBoundingClientRect();
          [...page.children].forEach(child => {
            const style=getComputedStyle(child);
            const rect=child.getBoundingClientRect();
            if (style.position==='absolute' && style.bottom!=='auto' && rect.width>=initialPageRect.width*0.5 && rect.height>20) {
              child.style.setProperty('position','relative','important');
              child.style.setProperty('left','auto','important');
              child.style.setProperty('right','auto','important');
              child.style.setProperty('top','auto','important');
              child.style.setProperty('bottom','auto','important');
              child.style.setProperty('width','100%','important');
              child.style.setProperty('height','auto','important');
              child.style.setProperty('min-height','0','important');
              child.style.setProperty('margin-top','4px','important');
            }
          });
          page.classList.add('__isolated_source_page__');
          document.body.replaceChildren(page);

          // Giữ nguyên kích thước outer box của mẫu. Nếu mẫu dùng content-box,
          // việc gán lại width bằng rect.width sẽ cộng padding lần thứ hai và
          // làm layout nở sang phải sau khi đã đo.
          const sourceRect=page.getBoundingClientRect();
          const stableWidth=Math.max(sourceRect.width,page.offsetWidth,1);
          const stableHeight=Math.max(sourceRect.height,page.offsetHeight,1);
          const robustA4=target.widthMm===210;
          if (robustA4) {
            page.style.setProperty('box-sizing','border-box','important');
            page.style.setProperty('width',stableWidth+'px','important');
            page.style.setProperty('height',stableHeight+'px','important');
            page.style.setProperty('min-width','0','important');
            page.style.setProperty('min-height','0','important');
            page.style.setProperty('max-width','none','important');
            page.style.setProperty('max-height','none','important');
          }

          const rect=page.getBoundingClientRect();
          const measuredElements=[...page.querySelectorAll('*')].filter(element =>
            visible(element) && !element.matches('.no-print,.menu-fix,.break-page,script,style,template')
          );
          let boxes=measuredElements.map(element => element.getBoundingClientRect());

          // getBoundingClientRect của ô có thể không bao hết chữ nowrap đang
          // overflow. Đo thêm từng text node bằng Range để mọi mẫu đều tính
          // được phần chữ thật sự xuất hiện ở mép phải.
          if (target.widthMm === 210) {
            const walker=document.createTreeWalker(page,NodeFilter.SHOW_TEXT);
            let textNode;
            while ((textNode=walker.nextNode())) {
              if (!textNode.nodeValue || !textNode.nodeValue.trim()) continue;
              const parent=textNode.parentElement;
              if (!parent || !visible(parent) || parent.closest('.no-print,.menu-fix,.break-page,script,style,template')) continue;
              const range=document.createRange();
              range.selectNodeContents(textNode);
              const textRect=range.getBoundingClientRect();
              if (textRect.width>0 && textRect.height>0) boxes.push(textRect);
              range.detach();
            }
          }
          if (!boxes.length) boxes=[rect];
          let minLeft=Math.min(...boxes.map(box=>box.left));
          let minTop=Math.min(...boxes.map(box=>box.top));
          let maxRight=Math.max(...boxes.map(box=>box.right));
          let maxBottom=Math.max(...boxes.map(box=>box.bottom));
          const boundsGuardMm=target.widthMm===210 ? 1 : 0;
          const boundsGuard=boundsGuardMm*96/25.4;
          minLeft-=boundsGuard;
          minTop-=boundsGuard;
          maxRight+=boundsGuard;
          maxBottom+=boundsGuard;
          const sideMargin=target.sideMarginMm*96/25.4;
          const verticalMargin=7*96/25.4;
          const contentWidth=Math.max(maxRight-minLeft,1);
          const contentHeight=Math.max(maxBottom-minTop,1);
          const printableWidth=target.widthPx-sideMargin*2;
          const printableHeight=target.heightPx-verticalMargin*2;
          const scale=Math.min(printableWidth/contentWidth,printableHeight/contentHeight);
          const contentLeft=minLeft-rect.left;
          const contentTop=minTop-rect.top;
          const shell=document.createElement('section');
          shell.id='__isolated_print_sheet__';
          page.style.setProperty('position','absolute','important');
          if (!robustA4) {
            page.style.setProperty('width',Math.max(rect.width,page.offsetWidth)+'px','important');
            page.style.setProperty('height',Math.max(rect.height,page.offsetHeight)+'px','important');
            page.style.setProperty('min-width','0','important');
            page.style.setProperty('min-height','0','important');
          }
          page.style.setProperty('margin','0','important');
          page.style.setProperty('transform-origin','top left','important');
          page.style.setProperty('transform','scale('+scale+')','important');
          page.style.setProperty('left',(sideMargin+(printableWidth-contentWidth*scale)/2-contentLeft*scale)+'px','important');
          page.style.setProperty('top',(verticalMargin-contentTop*scale)+'px','important');
          shell.appendChild(page);
          document.body.replaceChildren(shell);
          const sheetStyle=document.createElement('style');
          sheetStyle.textContent='html,body{margin:0!important;padding:0!important;width:'+target.widthMm+'mm!important;height:'+target.heightMm+'mm!important;overflow:hidden!important;background:#fff!important}' +
            '#__isolated_print_sheet__{position:relative!important;width:'+target.widthMm+'mm!important;height:'+target.heightMm+'mm!important;margin:0!important;padding:0!important;overflow:hidden!important;break-after:auto!important;page-break-after:auto!important}';
          document.head.appendChild(sheetStyle);
          return {
            page:pageIndex+1,
            contentWidth:Math.round(contentWidth*100)/100,
            contentHeight:Math.round(contentHeight*100)/100,
            scale:Math.round(scale*10000)/10000,
            sideMarginMm:target.sideMarginMm,
            verticalMarginMm:7,
            boundsGuardMm
          };
        })()`);
        pageDiagnostics.push(pageDiagnostic);
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
        let pageBytes=await window.webContents.printToPDF({ printBackground:true,preferCSSPageSize:true,pageSize:targetSize,margins:{top:0,bottom:0,left:0,right:0} });
        let rendered=await PDFDocument.load(pageBytes);
        if (rendered.getPageCount() > 1) {
          pageBytes=await mergePdfPagesVertically(pageBytes);
          rendered=await PDFDocument.load(pageBytes);
        }
        if (streamOptions) {
          await streamOptions.onPage({
            pageBytes,
            pageIndex,
            sourcePageCount:layout.pageCount,
            diagnostic:pageDiagnostic,
            sequenceIndex,
            sequenceCount:pageIndices.length
          });
        } else {
          const [copied]=await combined.copyPages(rendered,[0]);
          combined.addPage(copied);
        }
      }
      if (streamOptions) return {handled:true,sourcePageCount:layout.pageCount,renderedPageCount:pageIndices.length,pageDiagnostics};
      const combinedBytes=await combined.save({useObjectStreams:true});
      await fs.writeFile(outputPath,combinedBytes);
      if (targetSize === 'A4') {
        (async()=>{
          const diagnosticDir=path.join(app.getPath('documents'),'A4-A5-Printer-Debug');
          await fs.mkdir(diagnosticDir,{recursive:true});
          await Promise.all([
            fs.writeFile(path.join(diagnosticDir,'A4-paginated-preview-latest.pdf'),combinedBytes),
            fs.writeFile(path.join(diagnosticDir,'A4-paginated-preview-latest.json'),JSON.stringify({
              targetSize,
              pages:pageDiagnostics,
              safeMarginsMm:{left:10,right:10,top:7,bottom:7}
            },null,2),'utf8')
          ]);
        })().catch(()=>{});
      }
      return;
    }

    if (streamOptions) return {handled:false,sourcePageCount:layout.pageCount};

    let options;
    if (layout.hasExplicitPagination) {
      try {
        window.webContents.debugger.attach('1.3');
        debuggerAttached = true;
        await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{ media:'print' });
        await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
      } catch {
        if (debuggerAttached) {
          try { window.webContents.debugger.detach(); } catch {}
          debuggerAttached = false;
        }
      }
      const target = targetSize === 'A5'
        ? { widthMm:148, heightMm:210, widthPx:148*96/25.4, heightPx:210*96/25.4 }
        : { widthMm:210, heightMm:297, widthPx:210*96/25.4, heightPx:297*96/25.4 };
      await window.webContents.executeJavaScript(`(async () => {
        const target = ${JSON.stringify(target)};
        const visible = element => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const pages = [...document.querySelectorAll('.page, [data-print-page]')].filter(visible);
        const fragment = document.createDocumentFragment();
        const sideMargin = 4*96/25.4;
        const topMargin = 7*96/25.4;
        const bottomMargin = 9*96/25.4;
        const compactStyle = document.createElement('style');
        compactStyle.textContent =
          '.__html_compact__ label,.__html_compact__ span,.__html_compact__ td,.__html_compact__ th,.__html_compact__ p,.__html_compact__ div{line-height:1.08!important}' +
          '.__html_compact__ td,.__html_compact__ th{padding-top:1px!important;padding-bottom:1px!important}' +
          '.__html_compact__ p{margin-top:1px!important;margin-bottom:1px!important}' +
          '.__html_compact_tight__ label,.__html_compact_tight__ span,.__html_compact_tight__ td,.__html_compact_tight__ th,.__html_compact_tight__ p,.__html_compact_tight__ div{line-height:1!important}' +
          '.__html_compact_tight__ td,.__html_compact_tight__ th{padding-top:0!important;padding-bottom:0!important}' +
          '.__html_compact_tight__ p{margin-top:0!important;margin-bottom:0!important}' +
          '.__html_compact__.first-page>.first-page-signatures{position:relative!important;left:auto!important;right:auto!important;bottom:auto!important;width:100%!important;height:auto!important;min-height:0!important;margin:2mm 0 0!important;padding:0!important;overflow:visible!important}' +
          '.__html_compact__.first-page>.first-page-signatures>table{width:100%!important;height:auto!important;min-height:0!important;margin:0!important;table-layout:fixed!important;overflow:visible!important}' +
          '.__html_compact__.first-page .first-page-signatures>table>tbody>tr:first-child{height:auto!important;min-height:0!important}' +
          '.__html_compact__.first-page .first-page-signatures .tr-chuky{height:auto!important;min-height:25mm!important;overflow:visible!important}' +
          '.__html_compact__.first-page .first-page-signatures .tr-chuky .kyso,.__html_compact__.first-page .first-page-signatures #sign-block-3,.__html_compact__.first-page .first-page-signatures #sign-block-4{height:auto!important;min-height:24mm!important;overflow:visible!important}' +
          '.__html_compact__.first-page .first-page-signatures .signature-container{height:auto!important;min-height:24mm!important;overflow:visible!important}' +
          '.__html_compact__.first-page .first-page-signatures .signature-backup-name{display:block!important;position:relative!important;padding-top:16mm!important;padding-bottom:1mm!important;line-height:1.05!important;font-size:8.5pt!important;white-space:nowrap!important;overflow:visible!important;visibility:visible!important}';
        document.head.appendChild(compactStyle);

        const verticalRatio = page => {
          const rect = page.getBoundingClientRect();
          const visibleBoxes = [...page.querySelectorAll('*')].filter(element =>
            !element.matches('.no-print,.menu-fix,.break-page,script,style,template') && visible(element)
          ).map(element => element.getBoundingClientRect());
          if (!visibleBoxes.length) return 1;
          const top=Math.min(...visibleBoxes.map(box => box.top));
          const bottom=Math.max(...visibleBoxes.map(box => box.bottom));
          const contentHeight=Math.max(bottom-top,1);
          const widthScale=(target.widthPx-sideMargin*2)/Math.max(rect.width,1);
          const heightScale=(target.heightPx-topMargin-bottomMargin)/contentHeight;
          return widthScale/Math.max(heightScale,0.01);
        };
        pages.forEach((page,index) => {
          if (index === 0 || verticalRatio(page) > 1.02) page.classList.add('__html_compact__');
        });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        pages.forEach(page => {
          if (verticalRatio(page) > 1.08) page.classList.add('__html_compact_tight__');
        });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));

        pages.forEach(page => {
          const rect = page.getBoundingClientRect();
          const naturalWidth = Math.max(rect.width,page.offsetWidth,1);
          const naturalHeight = Math.max(rect.height,page.offsetHeight,1);
          const measured = [...page.querySelectorAll('*')].filter(element => {
            if (element.matches('.no-print,.menu-fix,.break-page,script,style,template')) return false;
            if (!visible(element)) return false;
            const style = getComputedStyle(element);
            if (Number(style.opacity) === 0) return false;
            return true;
          });
          let minLeft=Infinity,minTop=Infinity,maxRight=-Infinity,maxBottom=-Infinity;
          measured.forEach(element => {
            const box = element.getBoundingClientRect();
            minLeft=Math.min(minLeft,box.left);
            minTop=Math.min(minTop,box.top);
            maxRight=Math.max(maxRight,box.right);
            maxBottom=Math.max(maxBottom,box.bottom);
          });
          if (!Number.isFinite(minLeft)) {
            minLeft=rect.left; minTop=rect.top; maxRight=rect.right; maxBottom=rect.bottom;
          }
          const contentLeft=minLeft-rect.left;
          const contentTop=minTop-rect.top;
          const contentWidth=Math.max(maxRight-minLeft,1);
          const contentHeight=Math.max(maxBottom-minTop,1);
          const availableWidth=target.widthPx-sideMargin*2;
          const availableHeight=target.heightPx-topMargin-bottomMargin;
          const scale = Math.min(availableWidth/contentWidth,availableHeight/contentHeight);
          const placedLeft=sideMargin+(availableWidth-contentWidth*scale)/2-contentLeft*scale;
          const placedTop=topMargin+(availableHeight-contentHeight*scale)/2-contentTop*scale;
          const shell = document.createElement('section');
          shell.className = '__html_print_sheet__';
          page.style.setProperty('position', 'absolute', 'important');
          page.style.setProperty('box-sizing', 'border-box', 'important');
          page.style.setProperty('width', naturalWidth + 'px', 'important');
          page.style.setProperty('min-width', '0', 'important');
          page.style.setProperty('height', naturalHeight + 'px', 'important');
          page.style.setProperty('min-height', '0', 'important');
          page.style.setProperty('max-width', 'none', 'important');
          page.style.setProperty('max-height', 'none', 'important');
          page.style.setProperty('margin', '0', 'important');
          page.style.setProperty('break-before', 'auto', 'important');
          page.style.setProperty('break-after', 'auto', 'important');
          page.style.setProperty('page-break-before', 'auto', 'important');
          page.style.setProperty('page-break-after', 'auto', 'important');
          page.style.setProperty('transform-origin', 'top left', 'important');
          page.style.setProperty('transform', 'scale(' + scale + ')', 'important');
          page.style.setProperty('left', placedLeft + 'px', 'important');
          page.style.setProperty('top', placedTop + 'px', 'important');
          shell.appendChild(page);
          fragment.appendChild(shell);
        });

        document.body.replaceChildren(fragment);
        const style = document.createElement('style');
        style.textContent =
          '@page{size:' + target.widthMm + 'mm ' + target.heightMm + 'mm;margin:0}' +
          'html,body{margin:0!important;padding:0!important;width:' + target.widthMm + 'mm!important;background:#fff!important}' +
          '.__html_print_sheet__{position:relative!important;display:block!important;width:' + target.widthMm +
          'mm!important;height:' + target.heightMm + 'mm!important;margin:0!important;padding:0!important;' +
          'overflow:hidden!important;break-before:auto!important;page-break-before:auto!important;' +
          'break-after:page!important;page-break-after:always!important}' +
          '.__html_print_sheet__:last-child{break-after:auto!important;page-break-after:auto!important}';
        document.head.appendChild(style);
        return pages.length;
      })()`);
      options = { printBackground:true, preferCSSPageSize:true, pageSize:targetSize, margins:{ top:0, bottom:0, left:0, right:0 } };
    } else {
      const contentSize = await window.webContents.executeJavaScript(`(() => {
        const style = document.createElement('style');
        style.id = '__single_page_print__';
        style.textContent = \`@media print {
          html, body { margin: 0 !important; padding: 0 !important; }
          .page, [data-print-page] {
            margin: 0 !important;
            break-before: auto !important; break-after: auto !important;
            page-break-before: auto !important; page-break-after: auto !important;
          }
        }\`;
        document.head.appendChild(style);
        const root = document.documentElement;
        const body = document.body;
        const width = Math.max(root.scrollWidth, body.scrollWidth, root.offsetWidth, body.offsetWidth);
        const height = Math.max(root.scrollHeight, body.scrollHeight, root.offsetHeight, body.offsetHeight);
        return { width, height };
      })()`);
      // Electron custom page sizes use microns. 96 CSS px = 1 inch.
      const pxToMicrons = value => Math.max(353, Math.ceil((value + 2) * 25400 / 96));
      options = {
        printBackground:true,
        preferCSSPageSize:false,
        pageSize:{ width:pxToMicrons(contentSize.width), height:pxToMicrons(contentSize.height) },
        margins:{ top:0, bottom:0, left:0, right:0 }
      };
    }
    let bytes;
    if (!layout.hasExplicitPagination) {
      // Print CSS can change the measured height. Retry with a taller custom
      // sheet until Chromium really emits one page, then merge as a final guard.
      for (let attempt=0; attempt<3; attempt += 1) {
        bytes = await window.webContents.printToPDF(options);
        const probe = await PDFDocument.load(bytes);
        const pageCount = probe.getPageCount();
        if (pageCount === 1) break;
        options.pageSize.height = Math.ceil(options.pageSize.height * pageCount * 1.05);
      }
      bytes = await mergePdfPagesVertically(bytes);
    } else {
      bytes = await window.webContents.printToPDF(options);
    }
    await fs.writeFile(outputPath, bytes);
  } finally {
    if (debuggerAttached) {
      try { window.webContents.debugger.detach(); } catch {}
    }
    window.destroy();
  }
}

async function rotateSinglePagePdf180(bytes) {
  const source=await PDFDocument.load(bytes);
  const sourcePage=source.getPage(0);
  const {width,height}=sourcePage.getSize();
  const result=await PDFDocument.create();
  const [embedded]=await result.embedPages([sourcePage]);
  const page=result.addPage([width,height]);
  page.drawPage(embedded,{x:width,y:height,width:embedded.width,height:embedded.height,rotate:degrees(180)});
  return result.save({useObjectStreams:true});
}

async function createBlankPagePdf(targetSize) {
  const target=PAPER[targetSize] || PAPER.A4;
  const document=await PDFDocument.create();
  document.addPage([target.width,target.height]);
  return document.save({useObjectStreams:true});
}

async function printPaginatedHtmlStreaming(inputPath,options,onProgress=()=>{}) {
  const startedAt=Date.now();
  const targetSize=options.targetSize;
  const target=PAPER[targetSize] || PAPER.A4;
  const pageSelection=['odd','even'].includes(options.pages) ? options.pages : 'all';
  const reversePages=options.reverse === true;
  const rotateBackSide=options.rotateBackSide === true;
  const copies=Math.max(1,Number(options.copies)||1);
  const spoolDir=path.join(app.getPath('temp'),'a4-a5-printer-spool');
  await fs.mkdir(spoolDir,{recursive:true});
  const spoolEntries=[];
  let selectedIndices=[];
  let pageOrder=[];
  let sourcePageCount=0;
  let manualDuplexPadding=false;
  let firstPageSubmittedMs=null;
  let spoolChain=Promise.resolve();
  const pendingSpoolTasks=[];
  const timings={};

  const submitNewPage=async(bytes,pageNumber)=>{
    const spoolPath=path.join(spoolDir,`${targetSize}-page-${crypto.randomUUID()}.pdf`);
    await fs.writeFile(spoolPath,bytes);
    const entry={path:spoolPath,pageNumber,submitted:false};
    spoolEntries.push(entry);
    await print(spoolPath,{
      printer:options.deviceName,
      paperSize:targetSize,
      paperKind:target.kind,
      scale:'noscale',
      monochrome:options.color === false,
      copies:1,
      silent:true
    });
    entry.submitted=true;
    if (firstPageSubmittedMs === null && pageNumber !== null) firstPageSubmittedMs=Date.now()-startedAt;
  };

  try {
    const rendered=await htmlToPdf(inputPath,null,targetSize,{
      getPageIndices:pageCount=>{
        sourcePageCount=pageCount;
        selectedIndices=Array.from({length:pageCount},(_value,index)=>index).filter(index=>
          pageSelection === 'all' || (pageSelection === 'odd' ? index % 2 === 0 : index % 2 === 1)
        );
        if (!selectedIndices.length) throw new Error(`Tài liệu không có trang ${pageSelection === 'even' ? 'chẵn' : 'lẻ'} để in`);
        if (reversePages) selectedIndices.reverse();
        manualDuplexPadding=pageSelection === 'even' && reversePages && pageCount % 2 === 1;
        pageOrder=[...(manualDuplexPadding?[null]:[]),...selectedIndices.map(index=>index+1)];
        return selectedIndices;
      },
      onBeforePage:({sequenceIndex,sequenceCount,pageIndex})=>{
        onProgress(`Đang scale và gửi trang ${pageIndex+1} (${sequenceIndex+1}/${sequenceCount})...`);
      },
      onPage:async({pageBytes,sequenceIndex})=>{
        const task=spoolChain.then(async()=>{
          if (sequenceIndex === 0 && manualDuplexPadding) {
            await submitNewPage(await createBlankPagePdf(targetSize),null);
          }
          const printableBytes=rotateBackSide ? await rotateSinglePagePdf180(pageBytes) : pageBytes;
          await submitNewPage(printableBytes,selectedIndices[sequenceIndex]+1);
        });
        spoolChain=task;
        task.catch(()=>{});
        pendingSpoolTasks.push(task);
        // Cho phép Chromium render trước tối đa một trang trong lúc trang hiện
        // tại được gửi driver, nhưng vẫn giữ thứ tự các job trong Spooler.
        if (pendingSpoolTasks.length >= 2) await pendingSpoolTasks.shift();
      }
    });
    if (!rendered.handled) return {handled:false};
    await spoolChain;
    timings.renderAndFirstCopyMs=Date.now()-startedAt;

    // Các bản tiếp theo dùng lại PDF từng trang đã render, không scale lại.
    const extraCopiesStartedAt=Date.now();
    for (let copyIndex=1;copyIndex<copies;copyIndex+=1) {
      for (let entryIndex=0;entryIndex<spoolEntries.length;entryIndex+=1) {
        const entry=spoolEntries[entryIndex];
        onProgress(`Đang gửi bản ${copyIndex+1}/${copies}, tờ ${entryIndex+1}/${spoolEntries.length}...`);
        await print(entry.path,{
          printer:options.deviceName,
          paperSize:targetSize,
          paperKind:target.kind,
          scale:'noscale',
          monochrome:options.color === false,
          copies:1,
          silent:true
        });
      }
    }
    timings.extraCopiesMs=Date.now()-extraCopiesStartedAt;
    timings.firstPageSubmittedMs=firstPageSubmittedMs;
    timings.totalPipelineMs=Date.now()-startedAt;
    onProgress(`Đã gửi ${spoolEntries.length} tờ tới Windows Print Spooler.`);
    return {
      handled:true,
      ok:true,
      pages:spoolEntries.length,
      contentPages:selectedIndices.length,
      sourcePages:sourcePageCount,
      pageSelection,
      reversePages,
      rotateBackSide,
      manualDuplexPadding,
      pageOrder,
      targetSize,
      orientation:'portrait',
      streamedByPage:true,
      timings
    };
  } finally {
    for (const entry of spoolEntries) {
      if (entry.submitted) {
        const cleanup=setTimeout(()=>fs.unlink(entry.path).catch(()=>{}),60000);
        cleanup.unref();
      } else {
        try { await fs.unlink(entry.path); } catch {}
      }
    }
  }
}

async function imageToPdf(inputPath, outputPath) {
  const bytes = await fs.readFile(inputPath);
  const doc = await PDFDocument.create();
  const ext = extensionOf(inputPath);
  const image = ext === '.png' ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
  const landscape = image.width > image.height;
  const size = landscape ? [PAPER.A4.height, PAPER.A4.width] : [PAPER.A4.width, PAPER.A4.height];
  const page = doc.addPage(size);
  const margin = 18;
  const scale = Math.min((size[0]-margin*2)/image.width, (size[1]-margin*2)/image.height);
  const width=image.width*scale, height=image.height*scale;
  page.drawImage(image,{x:(size[0]-width)/2,y:(size[1]-height)/2,width,height});
  await fs.writeFile(outputPath, await doc.save());
}

async function findLibreOffice() {
  const candidates = [
    process.env.LIBREOFFICE_PATH,
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe'
  ].filter(Boolean);
  for (const candidate of candidates) { try { await fs.access(candidate); return candidate; } catch {} }
  try {
    const result = await execFileAsync('where.exe',['soffice.exe'],{windowsHide:true});
    return result.stdout.split(/\r?\n/).find(Boolean);
  } catch { return null; }
}

async function officeToPdf(inputPath, outputPath, jobDir) {
  const ext = extensionOf(inputPath);
  const type = ['.doc','.docx'].includes(ext) ? 'word' : 'excel';
  const psScript = path.join(__dirname, 'office-convert.ps1');
  try {
    await execFileAsync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',psScript,'-InputPath',inputPath,'-OutputPath',outputPath,'-Type',type],{windowsHide:true,timeout:120000});
    await fs.access(outputPath); return;
  } catch (officeError) {
    const soffice = await findLibreOffice();
    if (!soffice) throw new Error(`Không chuyển được ${ext}. Hãy cài Microsoft Office hoặc LibreOffice. Chi tiết: ${officeError.message}`);
    await execFileAsync(soffice,['--headless','--convert-to','pdf','--outdir',jobDir,inputPath],{windowsHide:true,timeout:120000});
    const generated = path.join(jobDir,`${path.basename(inputPath,path.extname(inputPath))}.pdf`);
    if (generated !== outputPath) await fs.copyFile(generated,outputPath);
  }
}

async function convertToPdf(inputPath, jobDir, targetSize) {
  const ext = extensionOf(inputPath);
  if (!isSupported(inputPath)) throw new Error(`Định dạng ${ext || 'không xác định'} chưa được hỗ trợ`);
  if (ext === '.pdf') return inputPath;
  const outputPath = path.join(jobDir,'converted.pdf');
  if (ext === '.html' || ext === '.htm') await htmlToPdf(inputPath,outputPath,targetSize);
  else if (['.png','.jpg','.jpeg'].includes(ext)) await imageToPdf(inputPath,outputPath);
  else await officeToPdf(inputPath,outputPath,jobDir);
  return outputPath;
}

async function inspectPreparedHtmlPdf(inputPdf,targetSize) {
  const target=PAPER[targetSize] || PAPER.A4;
  const document=await PDFDocument.load(await fs.readFile(inputPdf),{ignoreEncryption:false});
  const pages=document.getPages();
  if (!pages.length) return null;
  const tolerance=1;
  const matchesTarget=pages.every(page=>{
    const {width,height}=page.getSize();
    const portrait=Math.abs(width-target.width)<=tolerance && Math.abs(height-target.height)<=tolerance;
    const landscape=Math.abs(width-target.height)<=tolerance && Math.abs(height-target.width)<=tolerance;
    return portrait || landscape;
  });
  if (!matchesTarget) return null;
  const firstSize=pages[0].getSize();
  return {
    orientation:firstSize.width>firstSize.height?'landscape':'portrait',
    paperKind:target.kind,
    pages:pages.length,
    contentPages:pages.length,
    sourcePages:pages.length,
    pageSelection:'all',
    reversePages:false,
    rotateBackSide:false,
    manualDuplexPadding:false,
    pageOrder:pages.map((_page,index)=>index+1)
  };
}

async function normalizePdf(inputPdf, outputPdf, targetSize,margin=12,pageSelection='all',reversePages=false,rotateBackSide=false) {
  const target = PAPER[targetSize] || PAPER.A4;
  const source = await PDFDocument.load(await fs.readFile(inputPdf), { ignoreEncryption:false });
  const result = await PDFDocument.create();
  const sourcePages = source.getPages();
  let selectedEntries = sourcePages.map((page,index)=>({page,index})).filter(({index}) =>
    pageSelection === 'all' || (pageSelection === 'odd' ? index % 2 === 0 : index % 2 === 1)
  );
  if (!selectedEntries.length) throw new Error(`Tài liệu không có trang ${pageSelection === 'even' ? 'chẵn' : 'lẻ'} để in`);
  if (reversePages) selectedEntries=selectedEntries.reverse();
  const selectedPages=selectedEntries.map(entry=>entry.page);
  const embedded = await result.embedPages(selectedPages);
  const first = selectedPages[0];
  const firstRotation = ((first.getRotation().angle % 360) + 360) % 360;
  const firstSize = first.getSize();
  const firstLandscape = firstRotation % 180 === 0 ? firstSize.width > firstSize.height : firstSize.height > firstSize.width;
  const pageDimensions = sourcePage => {
    const rotation = ((sourcePage.getRotation().angle % 360) + 360) % 360;
    const size = sourcePage.getSize();
    const rotated = rotation === 90 || rotation === 270;
    const sourceWidth = rotated ? size.height : size.width;
    const sourceHeight = rotated ? size.width : size.height;
    return sourceWidth > sourceHeight
      ? {pageWidth:target.height,pageHeight:target.width}
      : {pageWidth:target.width,pageHeight:target.height};
  };
  // If the document has an odd page count, consume the unpaired last sheet
  // with a blank back side before printing reversed even pages.
  const manualDuplexPadding = pageSelection === 'even' && reversePages && sourcePages.length % 2 === 1;
  if (manualDuplexPadding) {
    const {pageWidth,pageHeight}=pageDimensions(sourcePages[sourcePages.length-1]);
    result.addPage([pageWidth,pageHeight]);
  }
  embedded.forEach((embeddedPage,index) => {
    const sourcePage = selectedPages[index];
    const rotation = ((sourcePage.getRotation().angle % 360) + 360) % 360;
    const outputRotation = (rotation + (rotateBackSide ? 180 : 0)) % 360;
    const rotated = rotation === 90 || rotation === 270;
    const sourceWidth = rotated ? embeddedPage.height : embeddedPage.width;
    const sourceHeight = rotated ? embeddedPage.width : embeddedPage.height;
    const landscape = sourceWidth > sourceHeight;
    const pageWidth = landscape ? target.height : target.width;
    const pageHeight = landscape ? target.width : target.height;
    const scale = Math.min((pageWidth-margin*2)/sourceWidth,(pageHeight-margin*2)/sourceHeight);
    const drawWidth=embeddedPage.width*scale, drawHeight=embeddedPage.height*scale;
    const page = result.addPage([pageWidth,pageHeight]);
    if (outputRotation === 90) page.drawPage(embeddedPage,{x:(pageWidth-drawHeight)/2+drawHeight,y:(pageHeight-drawWidth)/2,width:drawWidth,height:drawHeight,rotate:degrees(90)});
    else if (outputRotation === 270) page.drawPage(embeddedPage,{x:(pageWidth-drawHeight)/2,y:(pageHeight-drawWidth)/2+drawWidth,width:drawWidth,height:drawHeight,rotate:degrees(270)});
    else if (outputRotation === 180) page.drawPage(embeddedPage,{x:(pageWidth-drawWidth)/2+drawWidth,y:(pageHeight-drawHeight)/2+drawHeight,width:drawWidth,height:drawHeight,rotate:degrees(180)});
    else page.drawPage(embeddedPage,{x:(pageWidth-drawWidth)/2,y:(pageHeight-drawHeight)/2,width:drawWidth,height:drawHeight});
  });
  await fs.writeFile(outputPdf,await result.save({useObjectStreams:true}));
  return {
    orientation:firstLandscape?'landscape':'portrait',
    paperKind:target.kind,
    pages:result.getPageCount(),
    contentPages:selectedPages.length,
    sourcePages:sourcePages.length,
    pageSelection,
    reversePages:Boolean(reversePages),
    rotateBackSide:Boolean(rotateBackSide),
    manualDuplexPadding,
    pageOrder:[...(manualDuplexPadding?[null]:[]),...selectedEntries.map(entry=>entry.index+1)]
  };
}

async function sourceClearlyHasMultiplePrintPages(inputPath) {
  try {
    const source=await fs.readFile(inputPath,'utf8');
    const tags=source.match(/<[^>]+>/g) || [];
    let pageCount=0;
    for (const tag of tags) {
      if (/\bdata-print-page(?:\s|=|>)/i.test(tag)) {
        pageCount+=1;
      } else {
        const classAttribute=tag.match(/\bclass\s*=\s*(["'])(.*?)\1/is);
        if (classAttribute && classAttribute[2].split(/\s+/).includes('page')) pageCount+=1;
      }
      if (pageCount >= 2) return true;
    }
  } catch {}
  return false;
}

async function printDocument(options,onProgress=()=>{}) {
  const startedAt=Date.now();
  const timings={};
  let jobDir = null;
  let submittedToDriver = false;
  try {
    const pageSelection = ['odd','even'].includes(options.pages) ? options.pages : 'all';
    const reversePages = options.reverse === true;
    const rotateBackSide = options.rotateBackSide === true;
    if (['.html','.htm'].includes(extensionOf(options.filePath))) {
      // Các mẫu có nhiều vùng trang rõ ràng được đưa thẳng vào pipeline
      // streaming. Tránh mở toàn bộ HTML một lần chỉ để phát hiện phân trang,
      // rồi lại mở lần hai để render thật.
      const clearlyPaginated=pageSelection === 'even'
        ? true
        : await sourceClearlyHasMultiplePrintPages(options.filePath);
      // A one-page document is page 1 (odd). For an even-only request, use
      // the PDF path below so it can safely report that no page was selected.
      if (pageSelection !== 'even' && !clearlyPaginated) {
        const nativeResult = await printSinglePageHtmlNative(options.filePath,options,onProgress);
        if (nativeResult.handled) return {...nativeResult,pageSelection,reversePages,rotateBackSide:false,pageOrder:[1]};
        onProgress('HTML có phân trang: đang chuyển từng trang về PDF...');
      } else if (clearlyPaginated) {
        onProgress('Đã nhận diện HTML phân trang, đang scale và gửi từng trang...');
      }
      const streamedResult=await printPaginatedHtmlStreaming(options.filePath,{
        ...options,
        pages:pageSelection,
        reverse:reversePages,
        rotateBackSide
      },onProgress);
      if (streamedResult.handled) return streamedResult;
    }
    const jobSetupStartedAt=Date.now();
    jobDir=await makeJobDir();
    timings.jobSetupMs=Date.now()-jobSetupStartedAt;
    onProgress('Đang chuyển tài liệu về PDF...');
    const convertStartedAt=Date.now();
    const converted = await convertToPdf(options.filePath,jobDir,options.targetSize);
    timings.convertMs=Date.now()-convertStartedAt;
    let normalized = path.join(jobDir,`print-${options.targetSize}.pdf`);
    onProgress(`Đang chuẩn hóa toàn bộ trang về ${options.targetSize}...`);
    const htmlWithPages = ['.html','.htm'].includes(extensionOf(options.filePath));
    const normalizeStartedAt=Date.now();
    let info=null;
    // HTML phân trang đã được dựng trực tiếp trên MediaBox A4/A5 với lề an
    // toàn. Với lượt in toàn bộ theo thứ tự thường, dùng ngay PDF này để tránh
    // load/embed/save toàn bộ tài liệu thêm một lần nữa.
    if (htmlWithPages && pageSelection === 'all' && !reversePages && !rotateBackSide) {
      info=await inspectPreparedHtmlPdf(converted,options.targetSize);
      if (info) normalized=converted;
    }
    if (!info) {
      info=await normalizePdf(converted,normalized,options.targetSize,htmlWithPages ? 0 : 12,pageSelection,reversePages,rotateBackSide);
    } else {
      timings.normalizeSkipped=true;
    }
    timings.normalizeMs=Date.now()-normalizeStartedAt;
    onProgress(`Đang gửi ${info.pages} trang ${options.targetSize} tới Windows Print Spooler...`);
    const spoolStartedAt=Date.now();
    await print(normalized,{
      printer:options.deviceName,
      paperSize:options.targetSize,
      paperKind:info.paperKind,
      scale:'noscale',
      monochrome:options.color === false,
      copies:Math.max(1,Number(options.copies)||1),
      silent:true
    });
    timings.spoolMs=Date.now()-spoolStartedAt;
    submittedToDriver = true;
    onProgress('Đã gửi lệnh in tới Windows Print Spooler.');
    // Some legacy drivers (notably Canon CAPT/LBP2900) read the source PDF
    // after Sumatra has already returned. Keep it alive long enough for the
    // driver to finish spooling instead of deleting it immediately.
    timings.totalPipelineMs=Date.now()-startedAt;
    return {
      ok:true,
      pages:info.pages,
      contentPages:info.contentPages,
      sourcePages:info.sourcePages,
      pageSelection:info.pageSelection,
      reversePages:info.reversePages,
      rotateBackSide:info.rotateBackSide,
      manualDuplexPadding:info.manualDuplexPadding,
      pageOrder:info.pageOrder,
      targetSize:options.targetSize,
      orientation:info.orientation,
      timings
    };
  } catch (error) {
    timings.totalPipelineMs=Date.now()-startedAt;
    return {ok:false,error:error.message,timings};
  }
  finally {
    if (!jobDir) {
      // Single-page HTML is printed without allocating a conversion folder.
    } else if (submittedToDriver) {
      const cleanup = setTimeout(() => {
        fs.rm(jobDir,{recursive:true,force:true}).catch(() => {});
      },60000);
      cleanup.unref();
    } else {
      try { await fs.rm(jobDir,{recursive:true,force:true}); } catch {}
    }
  }
}

module.exports={SUPPORTED,isSupported,normalizePdf,printDocument};
