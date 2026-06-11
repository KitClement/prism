// Shared style constants. Exported from a module so import order can never
// reintroduce the "const is not hoisted" ordering bug.

const iSm = { padding:"3px 6px", border:"1px solid #ddd", borderRadius:5, fontSize:12, outline:"none", background:"#fafafa" };
const btnX = { background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:15, padding:"0 2px", lineHeight:1 };
const btnPlus = { padding:"3px 9px", background:"#f7f8fa", border:"1.5px dashed #ddd", borderRadius:5, fontSize:11, cursor:"pointer", color:"#666" };
const btnArr = { background:"none", border:"1px solid #eee", borderRadius:4, fontSize:11, cursor:"pointer", color:"#999", padding:"1px 4px" };
const btnNav = { padding:"3px 8px", background:"#f4f5f7", border:"1px solid #ddd", borderRadius:5, fontSize:11, cursor:"pointer", color:"#555" };
const ctrlLbl = { fontSize:12, color:"#555", display:"flex", alignItems:"center" };

// Code-panel sections (Task E). Four runnable sections + an integrated program, each
// color/symbol-coded to match the program's logo (four DISTINCT shapes so they stay
// distinguishable by shape alone). `cbColor` is the color-blind remap — only the two
// ambiguous hues change (red→black, green→gray); orange and blue are unchanged.
// `symbol` is an SVG path drawn centered in a 24×24 viewBox (used cut-out in the
// header gradient and in the integrated gutter). Read by every CodeBox + the gutter.
const CODE_SECTIONS = [
  { id:"sampler",   title:"Sampler",          symbol:"star",     color:"#ff2b2b", cbColor:"#000000" },
  { id:"single",    title:"Statistics",       symbol:"circle",   color:"#ffa92b", cbColor:"#ffa92b" },
  { id:"collect",   title:"For-loop",         symbol:"triangle", color:"#34ff2b", cbColor:"#9e9e9e" },
  { id:"inference", title:"Inference",        symbol:"square",   color:"#2b66ff", cbColor:"#2b66ff" },
];
// Resolve a section's effective color for the current color-blind mode.
const sectionColor = (sec, cb) => (cb ? sec.cbColor : sec.color);
// SVG path data (24×24 box, centered) for each section shape.
const SHAPE_PATH = {
  star:     "M12 2 L14.9 8.9 L22.4 9.5 L16.7 14.4 L18.5 21.7 L12 17.8 L5.5 21.7 L7.3 14.4 L1.6 9.5 L9.1 8.9 Z",
  circle:   "M12 3 A9 9 0 1 0 12 21 A9 9 0 1 0 12 3 Z",
  triangle: "M12 3 L21.5 20 L2.5 20 Z",
  square:   "M4 4 H20 V20 H4 Z",
};

export { iSm, btnX, btnPlus, btnArr, btnNav, ctrlLbl, CODE_SECTIONS, sectionColor, SHAPE_PATH };
