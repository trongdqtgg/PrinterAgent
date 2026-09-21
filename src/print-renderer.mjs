import * as pdfjsLib from '../node_modules/pdfjs-dist/build/pdf.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc = '../node_modules/pdfjs-dist/build/pdf.worker.mjs';

window.jobAPI.onPrepare(async job => {
  try {
    const dims = job.targetSize === 'A4' ? [210,297] : [148,210];
    const isLandscapeContent = job.contentOrientation === 'landscape';
    const [w,h] = isLandscapeContent ? [dims[1],dims[0]] : dims;
    const safeMarginMm = job.targetSize === 'A5' ? 4 : 6;
    document.getElementById('pageStyle').textContent = `@page{size:${w}mm ${h}mm;margin:0}.page{width:${w}mm;height:${h}mm}`;
    const fileBytes = await window.jobAPI.readPdf(job.filePath);
    const data = new Uint8Array(fileBytes);
    const pdf = await pdfjsLib.getDocument({ data }).promise;
    for (let n=1;n<=pdf.numPages;n++) {
      const page = await pdf.getPage(n);
      const source = page.getViewport({scale:1, rotation:page.rotate});
      const sourceIsLandscape = source.width > source.height;
      const rotation = (page.rotate + (sourceIsLandscape === isLandscapeContent ? 0 : 90)) % 360;
      const base = page.getViewport({scale:1, rotation});
      const pxW = (w - safeMarginMm * 2) / 25.4 * 144;
      const pxH = (h - safeMarginMm * 2) / 25.4 * 144;
      const scale = Math.min(pxW/base.width, pxH/base.height);
      const viewport = page.getViewport({scale, rotation});
      const wrapper=document.createElement('div'); wrapper.className='page';
      const canvas=document.createElement('canvas'); canvas.width=Math.ceil(viewport.width); canvas.height=Math.ceil(viewport.height);
      canvas.style.width=`${viewport.width/144*25.4}mm`; canvas.style.height=`${viewport.height/144*25.4}mm`;
      wrapper.appendChild(canvas); document.body.appendChild(wrapper);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
    }
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    window.jobAPI.done(job.windowId,{ok:true});
  } catch(error) { window.jobAPI.done(job.windowId,{ok:false,error:error.message}); }
});

window.jobAPI.ready(new URLSearchParams(window.location.search).get('id'));
