import {getDocument,GlobalWorkerOptions} from './vendor/pdfjs/build/pdf.min.mjs';
GlobalWorkerOptions.workerSrc='/vendor/pdfjs/build/pdf.worker.min.mjs';
export function previewPdf(bytes,area,isCurrent) {
  const task=getDocument({data:new Uint8Array(bytes),isEvalSupported:false,cMapUrl:'/vendor/pdfjs/cmaps/',cMapPacked:true,standardFontDataUrl:'/vendor/pdfjs/standard_fonts/',wasmUrl:'/vendor/pdfjs/wasm/'});
  const done=(async()=>{
    const pdf=await task.promise,limit=Math.min(pdf.numPages,10);
    if(!isCurrent())return;
    const summary=document.createElement('p');summary.className='small text-body-secondary';
    summary.textContent=pdf.numPages>10?`Showing the first 10 of ${pdf.numPages} pages. Download to read the full document.`:`${pdf.numPages} page${pdf.numPages===1?'':'s'} · verified PDF preview`;
    area.append(summary);
    for(let number=1;number<=limit;number++) {
      if(!isCurrent())return;
      const page=await pdf.getPage(number),original=page.getViewport({scale:1});
      const scale=Math.min(1.5,1000/original.width,1400/original.height),viewport=page.getViewport({scale});
      const canvas=document.createElement('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
      canvas.className='pdf-page';canvas.setAttribute('role','img');canvas.setAttribute('aria-label',`PDF page ${number}`);
      await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;
      if(!isCurrent())return;
      canvas.dataset.rendered='true';area.append(canvas);
      const text=await page.getTextContent(),description=document.createElement('p');
      description.className='visually-hidden';description.textContent=text.items.map(x=>x.str||'').join(' ').slice(0,10000);area.append(description);
      page.cleanup();
    }
  })();
  return {done,destroy:()=>task.destroy()};
}
