const fs = require('fs');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const pdfjs = require('pdfjs-dist/legacy/build/pdf.js');
const { sanitize, wrapChars, drawLine } = require('./app.js');
async function generate(text, subs){
  const spans = subs.map(s=>{const i=text.indexOf(s);return{start:i,end:i+s.length};});
  const doc=await PDFDocument.create();const font=await doc.embedFont(StandardFonts.Helvetica);
  const size=11,lh=15,margin=50,pageW=595.28,pageH=841.89,maxW=pageW-margin*2;
  const clean=sanitize(text);const marks=new Array(clean.length).fill(false);
  for(const s of spans)for(let i=s.start;i<s.end;i++)marks[i]=true;
  const chars=[];for(let i=0;i<clean.length;i++)chars.push({c:clean[i],r:marks[i]});
  const lines=wrapChars(chars,font,size,maxW);let page=doc.addPage([pageW,pageH]);let y=pageH-margin;
  for(const line of lines){if(y<margin){page=doc.addPage([pageW,pageH]);y=pageH-margin;}drawLine(page,line,margin,y,font,size,rgb);y-=lh;}
  return await doc.save();
}
async function extract(bytes){const doc=await pdfjs.getDocument({data:new Uint8Array(bytes),useSystemFonts:false}).promise;let out='';for(let p=1;p<=doc.numPages;p++){const page=await doc.getPage(p);const c=await page.getTextContent();out+=c.items.map(i=>i.str).join(' ');}return out;}
(async()=>{
  const text='Patient John Smith, SSN 123-45-6789, email john@example.com, seen in London. Card 4242 4242 4242 4242. Contact +44 7911 123456.';
  const bytes=await generate(text,['John Smith','123-45-6789','4242 4242 4242 4242','+44 7911 123456']);
  fs.writeFileSync('/sessions/epic-kind-carson/mnt/outputs/redacted-sample.pdf',Buffer.from(bytes));
  const ex=await extract(bytes);
  const check=(n,c)=>console.log((c?'PASS':'FAIL')+' - '+n);
  check('kept: Patient',ex.includes('Patient'));
  check('kept: email',ex.includes('example.com'));
  check('kept: London',ex.includes('London'));
  check('REDACTED name gone',!ex.includes('John')&&!ex.includes('Smith'));
  check('REDACTED ssn gone',!ex.includes('123-45-6789')&&!ex.includes('6789'));
  check('REDACTED card gone',!ex.includes('4242'));
  check('REDACTED phone gone',!ex.includes('7911')&&!ex.includes('123456'));
  console.log('\nExtracted text layer:\n'+JSON.stringify(ex.trim()));
})();
