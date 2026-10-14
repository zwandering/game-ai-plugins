const src=require('fs').readFileSync(__dirname+'/../../src/engine.js','utf8');
let G; try{G=require('../../src/engine.js');}catch(e){}
const create=(G&&G.createGomokuEngine)||(typeof G==='function'?G:null)||new Function(src+';return createGomokuEngine;')();
const {Engine,BLACK,WHITE}=create();
const P=(r,c)=>r*15+c;
function mk(b,w){const a=new Array(225).fill(0);b.forEach(([r,c])=>a[P(r,c)]=1);w.forEach(([r,c])=>a[P(r,c)]=2);const e=new Engine({rule:'renju'});e.setBoard(a);return e;}
let e=mk([[7,3],[7,5],[7,7],[7,9]],[[6,4],[8,6],[6,8],[2,2],[12,12]]);
console.log('X_XXX_X forb',e.isForbidden(P(7,6)),'legal',e.legal(P(7,6),BLACK));
const t=e.think(BLACK,{timeMs:2000});console.log('think',Math.floor(t.move/15),t.move%15,t.reason,t.score);
e=mk([[7,2],[7,3],[7,4],[7,8],[7,9],[7,10]],[[6,4],[8,6],[2,2],[12,12],[3,3],[11,11]]);
console.log('XXX_X_XXX forb',e.isForbidden(P(7,6)));
e=mk([[7,2],[7,3],[7,6],[7,8],[7,9]],[[6,4],[8,6],[2,2],[12,12],[3,3]]);
console.log('XX_XX_XX forb',e.isForbidden(P(7,5)));
