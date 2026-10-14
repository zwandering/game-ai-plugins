const G=require('../../src/engine.js')();const P=s=>(+s.slice(1))*15+s.charCodeAt(0)-65;const C=p=>String.fromCharCode(65+p%15)+(p/15|0);
const s='I7 H9 J9 I10 J11 I8 J7 J10 K7 H7 K10 H8';
const mk=()=>{const e=new G.Engine({rule:'freestyle'});s.split(' ').forEach((m,i)=>e.play(P(m),i%2?2:1));return e};
const e0=mk();const out=[];
for(let p=0;p<225;p++){if(!e0.legal(p,1))continue;const r0=p/15|0,c0=p%15;if(r0<4||r0>13||c0<5||c0>13)continue;
 const e=mk();e.play(p,1);if(e.hasWon(1)){out.push([C(p),'win']);continue}const r=e.think(2,{timeMs:1500});out.push([C(p),r.score]);}
console.log(out.filter(x=>x[1]<900000).map(x=>x.join(':')).join(' '));console.log('lost count',out.filter(x=>x[1]>=900000).length,'of',out.length);
