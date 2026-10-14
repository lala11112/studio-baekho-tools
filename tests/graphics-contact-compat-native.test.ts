import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const blender = process.env.BLENDER_PATH ?? 'C:/Program Files/Blender Foundation/Blender 5.0/blender.exe';

test('Blender compatibility omission preserves all other authored AST and old mesh prefixes without executing the module', { skip: !fs.existsSync(blender), timeout: 60_000 }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-contact-compat-'));
  t.after(() => {
    const resolved = fs.realpathSync(root);
    assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
    assert(path.basename(resolved).startsWith('ps-contact-compat-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  const author = path.join(root, 'author.py');
  // This reproduces the actual Blender 5 readonly-RNA failure. The deliberate
  // top-level exception proves the proof harness never executes this module.
  fs.writeFileSync(author, `import bpy
from mathutils import Vector
raise RuntimeError('The authored module must never execute in this proof')
def append_geometry(obj, points, faces):
 mesh=obj.data
 nv,ne,nf,nl=len(mesh.vertices),len(mesh.edges),len(mesh.polygons),len(mesh.loops)
 edge_map={tuple(sorted(e.vertices)):e.index for e in mesh.edges}
 added_edges=[]
 for face in faces:
  for a,b in zip(face,face[1:]+face[:1]):
   key=tuple(sorted((a,b)))
   if key not in edge_map:
    edge_map[key]=ne+len(added_edges);added_edges.append((a,b))
 mesh.vertices.add(len(points));mesh.edges.add(len(added_edges))
 mesh.loops.add(sum(map(len,faces)));mesh.polygons.add(len(faces))
 inv=obj.matrix_world.inverted()
 for i,p in enumerate(points):mesh.vertices[nv+i].co=inv@p
 for i,edge in enumerate(added_edges):mesh.edges[ne+i].vertices=edge
 cursor=nl
 for i,face in enumerate(faces):
  f=mesh.polygons[nf+i];f.loop_start=cursor;f.loop_total=len(face);f.use_smooth=True
  for j,v in enumerate(face):
   loop=mesh.loops[cursor+j];loop.vertex_index=v;loop.edge_index=edge_map[tuple(sorted((v,face[(j+1)%len(face)])))]
  cursor+=len(face)
 for name,start in [('partsmith_source_vertex',nv),('partsmith_source_face',nf),('partsmith_source_corner',nl)]:
  attr=mesh.attributes.get(name)
  if attr:
   for i in range(start,len(attr.data)):attr.data[i].value=-1
 mesh.update()
 return {'addedVertices':len(points),'addedEdges':len(added_edges),'addedFaces':len(faces)}
`, 'utf8');
  const reportPath = path.join(root, 'proof.json');
  const result = spawnSync(blender, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1', '--python', path.resolve('scripts/graphics-contact-blender-loop-check.py'), '--', author, reportPath, path.resolve('integrations/blender')], { encoding: 'utf8', windowsHide: true, timeout: 50_000, maxBuffer: 5 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stdout.slice(-7000) + result.stderr.slice(-5000));
  const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
  assert.equal(report.passed, true);
  assert.equal(report.productionCalls, 0);
  assert.equal(report.compatibilityReceipt.astEquivalenceAfterOmission, true);
  assert.equal(report.compatibilityReceipt.otherSourceLinesExact, true);
  assert(report.checks.length >= 15);
});
