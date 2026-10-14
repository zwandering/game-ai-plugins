const G=require('../../src/engine.js')();const P=s=>(+s.slice(1))*15+s.charCodeAt(0)-65;const C=p=>String.fromCharCode(65+p%15)+(p/15|0);
const cases=[['renju','I8 K8 K10 H7 J9 I6 L9 J5 L11 M12 G8 K6 H8 J8','K4','I9'],['freestyle','I7 H9 J9 I10 J11 I8 J7 J10 K7 H7 K10 H8','H6','H10'],['freestyle','H8 J9 J7 K8 L7 I8 K7 I7 I9 H7 G6 J10 J8 K10 L11 H10 I10 L6 M7 N7 M8 K6 M6 M9 F6 K9','F7','J6']];
const mk=(rule,s)=>{const e=new G.Engine({rule});s.split(' ').forEach((m,i)=>e.play(P(m),i%2?2:1));return e};
for(const [rule,s,bad,good] of cases){
  for(const ms of [300,1500,2000]){const r=mk(rule,s).think(1,{timeMs:ms});console.log(rule,ms,C(r.move),r.score,r.depth,r.timeMs)}
  for(const mv of [bad,good]){const e=mk(rule,s);e.play(P(mv),1);const r=e.think(2,{timeMs:5000});console.log('  after',mv,'white',C(r.move),r.score,r.depth)}
}
