import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {findBundledCodex} from '../engine/four-tiger-items/icon-runner';
test('item runner prefers the newest already installed app runtime, without changing model or config',async()=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'codex-discovery-'));
 for(const name of ['old','new']){await fs.mkdir(path.join(root,name));await fs.writeFile(path.join(root,name,'codex.exe'),'fixture');}
 await fs.utimes(path.join(root,'old','codex.exe'),new Date('2026-01-01'),new Date('2026-01-01'));
 await fs.utimes(path.join(root,'new','codex.exe'),new Date('2026-10-12'),new Date('2026-10-12'));
 assert.equal(findBundledCodex(root),path.join(root,'new','codex.exe'));assert.equal(findBundledCodex(path.join(root,'absent')),undefined);
});
