import { mathjax } from "mathjax-full/js/mathjax.js";
import { TeX } from "mathjax-full/js/input/tex.js";
import { SVG } from "mathjax-full/js/output/svg.js";
import { liteAdaptor } from "mathjax-full/js/adaptors/liteAdaptor.js";
import { RegisterHTMLHandler } from "mathjax-full/js/handlers/html.js";
import "mathjax-full/js/input/tex/ams/AmsConfiguration.js";
import type { LiteElement } from "mathjax-full/js/adaptors/lite/Element.js";
import { narrationWindow, sampleCurve, semanticFps, semanticFrame, type SemanticPlan } from "./semantic-math.ts";

const plot = { width: 770, height: 450 };
const resolutionScale = 1.5;
const themes = {
  dark: {
    bg: "#111820", plot: "#14212a", ink: "#f1f4f2", muted: "#a8bac4",
    grid: "#293c48", axis: "#526976", curve: "#6ddbc2", p: "#f1f4f2",
    q: "#ffc877", tangent: "#6ddbc2", reference: "#c6aff4",
  },
  light: {
    bg: "#f5f7f7", plot: "#edf2f2", ink: "#17242d", muted: "#526674",
    grid: "#d5e0e3", axis: "#879aa3", curve: "#137968", p: "#243742",
    q: "#985717", tangent: "#137968", reference: "#7551a6",
  },
};

const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);

function typeset(plan: SemanticPlan, ink: string) {
  const doc = mathjax.document("", {
    InputJax: new TeX({ packages: ["base", "ams"] }),
    OutputJax: new SVG({ fontCache: "none", internalSpeechTitles: false }),
  });
  const f = plan.graph.functionName;
  const x = plan.graph.variable;
  const quotient = String.raw`\frac{${f}(a+h)-${f}(a)}{h}`;
  const formulas = {
    function: `${f}(${x})`,
    points: String.raw`\begin{gathered}P=(a,${f}(a))\\Q=(a+h,${f}(a+h))\end{gathered}`,
    difference: String.raw`\begin{gathered}\Delta ${x}=h\\\Delta ${f}=${f}(a+h)-${f}(a)\end{gathered}`,
    secant: quotient,
    limit: String.raw`\lim_{h\to0}${quotient}`,
    tangent: String.raw`${f}'(a)=\lim_{h\to0}${quotient}`,
    compare: String.raw`${f}'(a)\quad\mathrm{and}\quad ${f}'(b)`,
  };
  const sizes: Record<string, { width: number; height: number }> = {};
  const assets: Record<string, string> = {};
  for (const [id, tex] of Object.entries(formulas)) {
    const node = doc.convert(tex, { display: true });
    const svg = adaptor.firstChild(node) as LiteElement;
    if (adaptor.getAttribute(svg, "data-mjx-error") || adaptor.tags(svg, "g").some(
      (g) => adaptor.getAttribute(g, "data-mml-node") === "merror",
    )) throw new Error("Could not typeset the formula");
    const [, , w, h] = adaptor.getAttribute(svg, "viewBox").split(" ").map(Number);
    const scale = Math.min(0.039, 282 / w, 102 / h);
    const width = Math.ceil(w * scale), height = Math.ceil(h * scale);
    if (!(width > 0 && height > 0)) throw new Error("Invalid formula dimensions");
    adaptor.setAttribute(svg, "width", String(width * resolutionScale));
    adaptor.setAttribute(svg, "height", String(height * resolutionScale));
    assets[id] = adaptor.outerHTML(svg).replaceAll("currentColor", ink);
    sizes[id] = { width, height };
  }
  return { sizes, assets };
}

export function semanticComposition(
  plan: SemanticPlan,
  options: {
    theme: "dark" | "light";
    audio: "pocket" | "wav" | "none";
    voice: "alba" | "marius";
    captions?: boolean;
  },
) {
  const { title, graph: { xLabel, yLabel, slopeUnit, variable }, beats } = plan;
  const color = themes[options.theme];
  const { sizes, assets } = typeset(plan, color.ink);
  // Holds reuse their settle frame. Only motion frames need new geometry.
  const shots = beats.map((beat) => Array.from({ length: beat.settleFrame - beat.startFrame + 1 }, (_, i) => {
    const { camera, p, q, h, rise, slope, kind, display, reference } = semanticFrame(plan, beat.startFrame + i);
    const curve = sampleCurve(plan, camera).map((point, j) => {
      const x = plot.width * (0.5 + (point.x - camera.x) / camera.width);
      const y = plot.height * (0.5 - (point.y - camera.y) / camera.height);
      return (j === 0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
    }).join("");
    return { camera, p, q, h, rise, slope, kind, display, reference, curve };
  }));
  const data = JSON.stringify(JSON.stringify({
    title, xLabel, yLabel, slopeUnit, variable, color, sizes, shots,
    beats: beats.map(({ startFrame, narration, caption }, i) => ({
      startFrame, narration, caption, ...narrationWindow(plan, i),
    })),
    frames: plan.durationSeconds * semanticFps,
    fps: semanticFps, plot, ...options,
  }));
  return {
    assets,
    source: `import React from 'react';
import {AbsoluteFill,Composition,registerRoot,useCurrentFrame} from 'raea';
import {Img} from 'raea/image';
import {staticFile} from 'raea/asset';
import {Audio,Mix} from 'raea/audio';
import {Speech,speechDuration} from 'raea/speech';

const {title,xLabel,yLabel,slopeUnit,variable,color,sizes,shots,beats,frames,fps,plot,audio,voice,captions}=JSON.parse(${data});
const {width:W,height:H}=plot;
if(audio==='pocket') beats.forEach((b,i)=>{
  const duration=speechDuration({text:b.narration,voice});
  if(!Number.isFinite(duration)||duration<=0) throw new Error('Narration could not be generated.');
  if(b.cueFrame+Math.ceil(duration*fps)>b.speechEndFrame) throw new Error('Narration at beat '+(i+1)+' exceeds its cue window. Shorten that utterance.');
});

const pxSize=n=>n*${resolutionScale};
const lengths=['width','height','fontSize','borderRadius'];
const pos=(left,top,style={})=>({
  position:'absolute',left:pxSize(left),top:pxSize(top),
  ...Object.fromEntries(Object.entries(style).map(([name,value])=>[name,lengths.includes(name)?pxSize(value):value])),
});
const clamp=(n,a,b)=>Math.max(a,Math.min(b,n));
const format=(n,digits=4)=>Number(n.toPrecision(digits)).toString().replace('-','−');
const value=(n,digits=4)=>format(n,digits)+(slopeUnit?' '+slopeUnit:'');
function ticks(center,span){
  const target=span/6, unit=10**Math.floor(Math.log10(target));
  const step=([1,2,5,10].find(n=>unit*n>=target))*unit;
  const first=Math.ceil((center-span/2)/step),last=Math.floor((center+span/2)/step);
  return Array.from({length:Math.max(0,last-first+1)},(_,i)=>(first+i)*step);
}

function Graph({shot}){
  const {camera,p,q,h,kind,display,reference,curve}=shot;
  const px=x=>W*(.5+(x-camera.x)/camera.width);
  const py=y=>H*(.5-(y-camera.y)/camera.height);
  const xt=ticks(camera.x,camera.width),yt=ticks(camera.y,camera.height);
  const points=display!=='function', guides=['difference','secant','limit'].includes(display);
  const line=['secant','limit','tangent','compare'].includes(display);
  const close=Math.hypot(px(q.x)-px(p.x),py(q.y)-py(p.y))<19;
  const active=kind==='secant'?color.q:color.tangent;
  function slopeLine(point,slope,stroke){
    const x0=camera.x-camera.width/2,x1=camera.x+camera.width/2;
    return <line x1="0" y1={py(point.y+slope*(x0-point.x))} x2={W} y2={py(point.y+slope*(x1-point.x))} stroke={stroke} strokeWidth="2.8"/>;
  }
  function label(point,name,ink,above){
    const x=px(point.x), y=py(point.y);
    if(x<0||x>W||y<0||y>H)return null;
    return <div style={pos(clamp(x+10,4,W-28),clamp(y+(above?-33:10),2,H-26),{color:ink,fontSize:19,fontWeight:700,backgroundColor:color.plot,borderRadius:3,padding:'0 '+pxSize(3)+'px'})}>{name}</div>;
  }
  return <>
    <div style={pos(105,155,{width:W,height:H,backgroundColor:color.plot,overflow:'hidden'})}>
      <svg width={pxSize(W)} height={pxSize(H)} viewBox={'0 0 '+W+' '+H} style={pos(0,0)}>
        <defs><clipPath id="plot"><rect x="0" y="0" width={W} height={H}/></clipPath></defs>
        <g clipPath="url(#plot)">
          {xt.map(x=><line key={x} x1={px(x)} y1="0" x2={px(x)} y2={H} stroke={x===0?color.axis:color.grid} strokeWidth={x===0?1.8:1}/>)}
          {yt.map(y=><line key={y} x1="0" y1={py(y)} x2={W} y2={py(y)} stroke={y===0?color.axis:color.grid} strokeWidth={y===0?1.8:1}/>)}
          {reference&&slopeLine(reference,reference.slope,color.reference)}
          {line&&slopeLine(p,shot.slope,active)}
          <path d={curve} fill="none" stroke={color.curve} strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
          {guides&&<path d={'M'+px(p.x)+' '+py(p.y)+'H'+px(q.x)+'V'+py(q.y)} fill="none" stroke={color.q} strokeWidth="2" strokeDasharray="5 5"/>}
          {reference&&<circle cx={px(reference.x)} cy={py(reference.y)} r="6" fill={color.reference} stroke={color.plot} strokeWidth="2"/>}
          {points&&<circle cx={px(p.x)} cy={py(p.y)} r="6" fill={color.p} stroke={color.plot} strokeWidth="2"/>}
          {points&&h!==0&&<circle cx={px(q.x)} cy={py(q.y)} r={close?9:6} fill={close?'none':color.q} stroke={close?color.q:color.plot} strokeWidth="2"/>}
        </g>
      </svg>
      {points&&label(p,'P',color.p,true)}
      {points&&h!==0&&label(q,'Q',color.q,false)}
      {reference&&label(reference,'B',color.reference,true)}
    </div>
    {xt.map(x=><div key={x} style={pos(105+px(x)-40,612,{width:80,textAlign:'center',fontSize:17,color:color.muted})}>{format(x,5)}</div>)}
    {yt.map(y=><div key={y} style={pos(23,145+py(y),{width:70,textAlign:'right',fontSize:17,color:color.muted})}>{format(y,5)}</div>)}
    <div style={pos(105,116,{fontSize:20,color:color.muted})}>{yLabel}</div>
    <div style={pos(570,633,{width:305,textAlign:'right',fontSize:18,color:color.muted})}>{xLabel}</div>
  </>;
}

function Formula({id,left,top}){
  const size=sizes[id];
  return <Img src={staticFile(id+'.svg')} style={pos(left,top,size)}/>;
}

function Notes({shot}){
  const {display,p,q,h,rise,slope,reference}=shot;
  const line=display==='secant'||display==='limit'||display==='tangent'||display==='compare';
  const tangent=h===0;
  const ink=tangent?color.tangent:color.q;
  const pointX=format(p.x,7), otherX=format(q.x,7);
  return <>
    <Formula id="function" left={934} top={156}/>
    <div style={pos(934,214,{width:282,height:1,backgroundColor:color.axis})}/>
    {display!=='function'&&<Formula id={display} left={934} top={247}/>}
    {display!=='function'&&display!=='compare'&&<div style={pos(934,374,{fontSize:23,color:color.muted})}>
      <div style={{color:color.p}}>P · {variable} = {pointX}</div>
      <div style={{marginTop:pxSize(10),color:tangent?color.muted:color.q}}>{tangent?'Q = P':'Q · '+variable+' = '+(pointX===otherX?'a + h':otherX)}</div>
      {display!=='points'&&<div style={{marginTop:pxSize(13),color:ink}}>h = {h===0?'0':format(h,3)}</div>}
      {display==='difference'&&<div style={{marginTop:pxSize(10),color:ink}}>Δy = {format(rise,4)}</div>}
    </div>}
    {line&&<div style={pos(934,reference?365:505,{fontSize:21,color:color.muted,width:305})}>
      <div>{tangent?'Tangent slope':'Secant slope'}{reference?' at P · '+variable+' = '+format(p.x,6):''}</div>
      <div style={{fontSize:pxSize(30),color:ink,fontWeight:700,marginTop:pxSize(5)}}>{value(slope)}</div>
      {reference&&<div style={{marginTop:pxSize(24)}}>
        <div>Tangent slope at B · {variable} = {format(reference.x,6)}</div>
        <div style={{fontSize:pxSize(30),color:color.reference,fontWeight:700,marginTop:pxSize(5)}}>{value(reference.slope)}</div>
      </div>}
    </div>}
  </>;
}

function Lesson(){
  const frame=useCurrentFrame();
  let i=beats.length-1;
  while(frame<beats[i].startFrame)i--;
  const beat=beats[i], shot=shots[i][Math.min(frame-beat.startFrame,shots[i].length-1)];
  return <AbsoluteFill style={{backgroundColor:color.bg,color:color.ink,fontFamily:'sans-serif'}}>
    <div style={pos(62,33,{width:1156,fontSize:Math.min(43,Math.max(27,2050/title.length)),fontWeight:700})}>{title}</div>
    <Graph shot={shot}/>
    <Notes shot={shot}/>
    {captions!==false&&beat.caption&&frame>=beat.cueFrame&&<div style={pos(172,656,{width:918,textAlign:'center',fontSize:22,lineHeight:'120%',backgroundColor:color.bg,padding:pxSize(5)+'px '+pxSize(10)+'px',borderRadius:6})}>{beat.caption}</div>}
    {audio==='wav'&&<Audio src={staticFile('narration.wav')}/>}
    {audio==='pocket'&&<Mix lufs={-16} ceiling={-2}>
      <Speech key={i} text={beat.narration} voice={voice} start={beat.cueFrame}/>
    </Mix>}
  </AbsoluteFill>;
}
registerRoot(()=> <Composition id="lesson" component={Lesson} width={1920} height={1080} fps={fps} durationInFrames={frames}/>);`,
  };
}
