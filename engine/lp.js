/* HiGHS 求解适配: 内部模型 -> CPLEX LP 文本 -> highs.solve -> x 数组
   模型: { n, obj[](最大化), rows[[col,coef]](<=ub), ub[], lo[], hi[], ints[]?,
           gap?, timeLimit? } */
export function makeSolver(highs) {
  const fmt = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return "0";
    return String(Number(n.toPrecision(12)));
  };
  const joinTerms = (terms) => {
    let s = "";
    for (const [c, v] of terms) {
      if (!v) continue;
      const vs = fmt(Math.abs(v));
      if (s === "") s = v < 0 ? `-${vs} x${c}` : `${vs} x${c}`;
      else s += v < 0 ? ` - ${vs} x${c}` : ` + ${vs} x${c}`;
    }
    return s;
  };
  const toLp = (m) => {
    const L = ["Maximize"];
    const objTerms = [];
    const used = new Set();
    for (let i = 0; i < m.n; i++) {
      if (m.obj[i]) { objTerms.push([i, m.obj[i]]); used.add(i); }
    }
    L.push(" obj: " + (joinTerms(objTerms) || "0 x0"));
    L.push("Subject To");
    let rc = 0;
    for (let r = 0; r < m.rows.length; r++) {
      const terms = m.rows[r].filter(([, v]) => v);
      if (!terms.length) continue;
      for (const [c] of terms) used.add(c);
      L.push(` c${rc++}: ` + joinTerms(terms) + ` <= ${fmt(m.ub[r])}`);
    }
    // 孤立变量(只出现在界中)补一行声明, 避免 LP 解析报未知变量
    const lonely = [];
    for (let i = 0; i < m.n; i++) if (!used.has(i)) lonely.push([i, 1]);
    if (lonely.length) L.push(" cZ: " + joinTerms(lonely) + " <= 1e12");
    if (rc === 0 && !lonely.length) L.push(" c0: 0 x0 <= 1");
    L.push("Bounds");
    for (let i = 0; i < m.n; i++) {
      const lo = m.lo[i] == null ? 0 : m.lo[i];
      const hi = m.hi[i];
      if (lo === hi) { L.push(` x${i} = ${fmt(lo)}`); continue; }
      if (lo > 0) L.push(` x${i} >= ${fmt(lo)}`);
      if (hi != null && isFinite(hi)) L.push(` x${i} <= ${fmt(hi)}`);
    }
    if (m.ints && m.ints.some(Boolean)) {
      L.push("Generals");
      const gs = [];
      for (let i = 0; i < m.n; i++) if (m.ints[i]) gs.push(`x${i}`);
      L.push(" " + gs.join(" "));
    }
    L.push("End");
    return L.join("\n");
  };
  return function solve(model) {
    const opts = { output_flag: false };
    if (model.gap != null) opts.mip_rel_gap = model.gap;
    if (model.timeLimit != null) opts.time_limit = model.timeLimit;
    let res;
    try {
      res = highs.solve(toLp(model), opts);
    } catch (e) {
      return null;
    }
    if (!res || res.Status !== "Optimal") return null;
    const x = new Array(model.n).fill(0);
    for (let i = 0; i < model.n; i++) {
      const pr = res.Columns["x" + i];
      if (pr && typeof pr.Primal === "number") x[i] = pr.Primal;
    }
    return x;
  };
}
