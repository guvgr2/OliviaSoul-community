// 「主动来信」设置页的护栏。
//
// 为什么要有这套：页签、静态白名单、脚本引用、页内引导分散在几个文件里，
// 漏任何一处都不会报错 —— 用户看到的是「侧栏没有这一页」或者「点了没反应」。
// 单元测试读的是源码，所以这里只能钉死「写法没退回去」；真机能不能点到
// 由 AGENTS.md §八 的真机必点清单管。
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const read = name => readFile(join(root, name), "utf8");

test("设置页脚本存在，且是普通 <script> 能加载的 IIFE（没有 import / export）", async () => {
  const file = join(root, "public", "proactive-settings.js");
  assert.ok(existsSync(file), "public/proactive-settings.js 不见了");
  const source = await read("public/proactive-settings.js");
  assert.match(source, /\(function \(global\) \{/u);
  assert.match(source, /\}\)\(window\);/u);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/mu);
});

test("静态白名单里有这个脚本（漏了页面会 404）", async () => {
  const server = await read("server.js");
  assert.match(server, /"proactive-settings\.js"/u);
});

test("index.html：页签、页面容器、脚本引用、页内引导四处齐全", async () => {
  const html = await read("public/index.html");
  assert.match(html, /data-tab="proactive"/u);
  assert.match(html, /data-page="proactive"[^>]*data-panel-mount="keep"/u);
  assert.match(html, /<script src="\/admin\/proactive-settings\.js"><\/script>/u);
  assert.match(html, /data-tip="主动来信/u);
  // 功能地图那条（AGENTS.md §二.8 的「用户引导 3 处」）。
  assert.match(html, /她什么时候会主动写信给我/u);
});

test("设置页只跟这三个接口打交道，并且按 code 判错（/toy/* 的错误是 HTTP 200）", async () => {
  const source = await read("public/proactive-settings.js");
  assert.match(source, /const BASE = "\/toy\/letter\/proactive";/u);
  assert.match(source, /body\.code !== 0/u);
  assert.match(source, /"\/check"/u);
});

test("作息表字段与后端 normalizeRoutine 的契约一致", async () => {
  const source = await read("public/proactive-settings.js");
  for (const field of ["from", "to", "activity", "label"]) {
    assert.match(source, new RegExp(`"${field}"`, "u"), `界面少了对 ${field} 的处理`);
  }
  // weekdays 是对象键（不带引号），后端 normalizeRoutine 认的就是这个名字。
  assert.match(source, /weekdays: WEEKDAYS\[/u);
  assert.match(await read("proactive-letters.js"), /export function normalizeRoutine/u);
});
