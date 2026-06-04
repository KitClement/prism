// Shared style constants. Exported from a module so import order can never
// reintroduce the "const is not hoisted" ordering bug.

const iSm = { padding:"3px 6px", border:"1px solid #ddd", borderRadius:5, fontSize:12, outline:"none", background:"#fafafa" };
const btnX = { background:"none", border:"none", color:"#ccc", cursor:"pointer", fontSize:15, padding:"0 2px", lineHeight:1 };
const btnPlus = { padding:"3px 9px", background:"#f7f8fa", border:"1.5px dashed #ddd", borderRadius:5, fontSize:11, cursor:"pointer", color:"#666" };
const btnArr = { background:"none", border:"1px solid #eee", borderRadius:4, fontSize:11, cursor:"pointer", color:"#999", padding:"1px 4px" };
const btnNav = { padding:"3px 8px", background:"#f4f5f7", border:"1px solid #ddd", borderRadius:5, fontSize:11, cursor:"pointer", color:"#555" };
const ctrlLbl = { fontSize:12, color:"#555", display:"flex", alignItems:"center" };

export { iSm, btnX, btnPlus, btnArr, btnNav, ctrlLbl };
