const G=require('../../src/engine.js')();
const P=s=>(+s.slice(1))*15+s.charCodeAt(0)-65;
const name=p=>String.fromCharCode(65+p%15)+Math.floor(p/15);
const mv='I6 K8 J5 I8 J6 K6 H7 K4 K5 J7 L5 I5 I7 L4 G6 H8 J8 G5 M5 N5 J4 N4 F9 G8 F6 H6 F7 F8 E8 D9 H5 I4 G10 D7 E7 G7 E9 E10 E6 E5 D8 L6 N6 C7 D6 C6 C8 B10 G11 H11 F3 F5 F10 H12 B8 A8 E2 G4 J3 J2'.split(' ');
const e=new G.Engine();mv.forEach((m,i)=>e.play(P(m),i%2?2:1));
console.log(e.toString());
let t=Date.now();console.log('20k', e.findVcf(2,20000,24), Date.now()-t);
t=Date.now();const big=e.findVcf(2,2000000,40);console.log('2M/40', big, big&&name(big.move), Date.now()-t,'ms nodesLeft',e.vcfNodes);
t=Date.now();const big24=e.findVcf(2,2000000,24);console.log('2M/24', big24, Date.now()-t);
const r=e.think(1,{timeMs:300});console.log('think',r.move,name(r.move),r.score,r.depth,r.reason);
e.play(r.move,1);t=Date.now();const after=e.findVcf(2,3000000,40);console.log('after H9 white vcf',after,after&&name(after.move),Date.now()-t);
// replay vcf line to confirm it's real
if(after){ console.log('verify with real play-out via think as white:'); const w=e.think(2,{timeMs:500}); console.log(name(w.move),w.score,w.reason);}
e.undo();
// cached vcf wrapper
const orig=G.Engine.prototype.vcf;
e.vcf=function(me,ply,maxPly,rootPly){
  const rem=maxPly-(ply-rootPly); const k=this.hashLo+':'+this.hashHi+':'+me;
  if(ply!==rootPly){const c=this.fc.get(k); if(c!==undefined&&c>=rem) return 0;}
  const before=this.vcfNodes; const res=orig.call(this,me,ply,maxPly,rootPly);
  if(!res && this.vcfNodes>0) this.fc.set(k,Math.max(this.fc.get(k)||0,rem));
  return res;};
const of=e.findVcf; e.findVcf=function(c,n,m){this.fc=new Map();return of.call(this,c,n,m);};
t=Date.now();const c=e.findVcf(2,20000,24);console.log('cached 20k',c,c&&name(c.move),'used',20000-e.vcfNodes,Date.now()-t);
const r2=e.think(1,{timeMs:300});console.log('cached think',name(r2.move),r2.score,r2.reason);
e.play(r2.move,1);delete e.findVcf;delete e.vcf;t=Date.now();console.log('after cached move white vcf 3M',e.findVcf(2,3000000,40),Date.now()-t);
