/* 浏览器端引擎客户端: 加载 HiGHS WASM + 游戏数据, 提供与原后端一致的调用 */
import { createEngine } from "./core.js";
import { makeSolver } from "./lp.js";
import loadHighs from "./vendor/highs.mjs";

let enginePromise = null;

export function getEngine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const [highs, data] = await Promise.all([
        loadHighs(),
        fetch(new URL("../game_data.json", import.meta.url)).then((r) => {
          if (!r.ok) throw new Error("游戏数据加载失败");
          return r.json();
        }),
      ]);
      const engine = createEngine(data, makeSolver(highs));
      engine.buildings = data.buildings;
      return engine;
    })().catch((e) => {
      enginePromise = null;               // 失败允许重试
      throw e;
    });
  }
  return enginePromise;
}
