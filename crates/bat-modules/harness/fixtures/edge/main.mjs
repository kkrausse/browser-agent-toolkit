#!/usr/bin/env node
"use strict";
import def, * as dep from './dep.mjs'
import { count, inc, obj, tag, Base, late, destructuredA, destructuredB, "string-name" as stringName, default2 } from './dep.mjs'
import * as defaults from './defaults.mjs';
import {} from './dep.mjs';
export * from './dep.mjs';
export { dep, def as renamedDefault };
export * as everything from './defaults.mjs';

const out = {};
out.first = [count, inc(), count, dep.count, stringName, default2 === inc];
out.calls = [(inc)() > 0, inc?.() > 0, tag`a${1}b`, obj.method(), (0, obj.method)(), new Base() instanceof dep.Base];
out.shorthand = (({ count, inc: renamed }) => [count, typeof renamed])({ count, inc });
out.shadow = ((count) => count)('param') + (() => { let inc = 'local'; { const count = 'block'; return inc + count; } })();
out.catchShadow = (() => { try { throw 'thrown'; } catch (count) { return count; } })();
out.label = (() => { count: for (;;) { break count; } return 'label-ok'; })();
out.fnNameShadow = (function count() { return typeof count; })();
out.classShadow = (() => { class inc {} return typeof inc; })();
out.typeofs = [typeof count, typeof inc, typeof late, typeof undefinedThing];
out.assign = (() => { try { count = 1; return 'no error'; } catch (e) { return e.constructor.name; } })();
out.destructureAssign = (() => { try { ({ count } = { count: 1 }); return 'no error'; } catch (e) { return e.constructor.name; } })();
out.update = (() => { try { count++; return 'no error'; } catch (e) { return e.constructor.name; } })();
out.late = [late, destructuredA, destructuredB];
out.template = `${count}:${inc.name}:${def()}`;
out.klass = class { static field = count; static [inc.name]() { return count; } }.field >= 0;
out.defaults = {
  arrowName: defaults.arrow.name, arrow: defaults.arrow(1, 2),
  klassName: defaults.klass.name, klassWho: defaults.klass.who(),
  asyncName: defaults.asyncFn.name, genName: defaults.gen.name,
  expr: defaults.expr, parenName: defaults.parenFn.name,
  objCount: typeof defaults.objWithImport.count, objNested: typeof defaults.objWithImport.nested.count,
};
out.meta = [typeof import.meta.url, import.meta.url.endsWith('main.mjs'), typeof import.meta.resolve, import.meta.hot, typeof import.meta.dirname];
out.thisValue = String(this);
out.dynamic = Object.keys(await import('./dep.mjs')).join();
out.dynamicExpr = (await import(`./dep.mjs`)).default.name + (await import('./de' + 'p.mjs', {})).destructuredA;
out.nsKeys = Object.keys(dep).join();
out.asyncArrow = await (async () => { for await (const v of [Promise.resolve(3)]) return v; })();
export const result = out;
export default out
