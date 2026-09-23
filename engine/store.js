/* 用户数据本地存储(localStorage): 设置/建筑数量/存量/效率/自定义
   自定义按 建筑名+产物名 持久化, 游戏数据更新后仍能对上 */
const KEY = "yimo.v1";

export const store = {
  load() {
    try {
      return JSON.parse(localStorage.getItem(KEY)) || {};
    } catch {
      return {};
    }
  },
  save(patch) {
    const d = this.load();
    Object.assign(d, patch);
    try {
      localStorage.setItem(KEY, JSON.stringify(d));
    } catch {
      /* 存储满等异常忽略 */
    }
    return d;
  },
};
