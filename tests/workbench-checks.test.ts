import {test} from "node:test";
import assert from "node:assert/strict";
import {blocksWorkbenchCheck,normalizeWorkbenchChecks,workbenchWarningMessages} from "../shared/workbench-checks";

test("model density/topology target deviations remain visible without bypassing structural checks",()=>{
  for(const name of ["model_polygon_target","model_quad_ratio","정확한 목표 면 수","전체 쿼드"]){
    const observation={name,passed:false,severity:"warning" as const,detail:"Target 10000; actual 10297, 9038 quads and 1259 triangles."};
    const normalized=normalizeWorkbenchChecks("model",[observation])[0];
    assert.equal(normalized.passed,false);assert.equal(normalized.severity,"warning");
    assert.match(workbenchWarningMessages("model",[normalized])[0],/10297/);
    assert.equal(blocksWorkbenchCheck("surface",observation),true);
    assert.equal(blocksWorkbenchCheck("model",{...observation,severity:"error"}),true);
    assert.equal(blocksWorkbenchCheck("model",{...observation,detail:""}),true);
    for(const failure of ["file_integrity","native_fbx","finite_vertices","wrong_model_settings","unknown_check"])
      assert.equal(blocksWorkbenchCheck("model",{...observation,name:failure}),true);
  }
});

test("animation appearance warning stays false; motion, integrity and unknown failures block",()=>{
  const warning={name:"visual_quality",passed:false,visualCategory:"appearance" as const,detail:"Original shoulder seam remains."};
  const checks=normalizeWorkbenchChecks("animation",[warning]);
  assert.equal(checks[0].passed,false);assert.equal(checks[0].severity,"warning");
  assert.match(workbenchWarningMessages("animation",checks)[0],/shoulder seam/);
  assert.equal(blocksWorkbenchCheck("animation",{name:"loop_endpoints",passed:true,visualCategory:"view_consistency"}),false);
  for(const name of ["loop_endpoints","foot_contact","file_integrity","unknown"])
    assert.equal(blocksWorkbenchCheck("animation",{...warning,name}),true,name);
  assert.equal(blocksWorkbenchCheck("animation",{...warning,visualCategory:"view_consistency"}),true);
});

test("reference visual mismatches stay false for human review; structural and unspecified failures block",()=>{
  const check={name:"visual_quality",passed:false,visualCategory:"view_consistency" as const,detail:"Foot position differs between views."};
  const normalized=normalizeWorkbenchChecks("reference",[check])[0];
  assert.equal(normalized.passed,false);assert.equal(normalized.severity,"warning");
  assert.match(workbenchWarningMessages("reference",[normalized])[0],/Foot position/);
  for(const name of ["file_integrity","timestamps","missing_frames","unknown_sync_check"])
    assert.equal(blocksWorkbenchCheck("reference",{...check,name}),true);
});

test("rig motion-range warning remains false; weights, failed poses and unknown checks still block",()=>{
  const warning={name:"remaining_limitations",passed:false,severity:"warning" as const,detail:"FK has no automatic foot lock; local joint compression remains."};
  const checks=normalizeWorkbenchChecks("rig",[warning]);
  assert.equal(checks[0].passed,false);assert.equal(blocksWorkbenchCheck("rig",checks[0]),false);
  assert.match(workbenchWarningMessages("rig",checks)[0],/compression/);
  assert.equal(blocksWorkbenchCheck("animation",warning),true);
  assert.equal(blocksWorkbenchCheck("rig",{...warning,severity:"error"}),true);
  for(const name of ["normalized_skin_weights","independent_pose_tests","file_integrity","unknown_check"])
    assert.equal(blocksWorkbenchCheck("rig",{...warning,name}),true,name);
});

test("assembly accepts a passed finite-category observation without mistaking its label for failure",()=>{
  assert.equal(blocksWorkbenchCheck("assembly",{name:"cheek_defect_removed",passed:true,visualCategory:"appearance"}),false);
  assert.equal(blocksWorkbenchCheck("assembly",{name:"geometry_preserved",passed:true,visualCategory:"view_consistency"}),false);
  assert.equal(blocksWorkbenchCheck("assembly",{name:"geometry_preserved",passed:false,visualCategory:"view_consistency"}),true);
  assert.equal(blocksWorkbenchCheck("assembly",{name:"geometry_preserved",passed:true,visualCategory:"unknown" as any}),true);
});
test("assembly appearance limits remain failed and visible while structural and unknown failures block",()=>{
  const checks=normalizeWorkbenchChecks("assembly",[{name:"remaining_visual_limits",passed:false,visualCategory:"appearance",detail:"Small whisker root color differences remain."}]);
  assert.equal(checks[0].passed,false);
  assert.equal(checks[0].severity,"warning");
  assert.equal(blocksWorkbenchCheck("assembly",checks[0]),false);
  assert.match(workbenchWarningMessages("assembly",checks)[0],/Small whisker/);
  for(const name of ["file_integrity","texture_and_uv_preserved","cheek_defect_removed","unknown_check"])
    assert.equal(blocksWorkbenchCheck("assembly",{name,passed:false,severity:"warning",visualCategory:"appearance"}),true,name);
  assert.equal(blocksWorkbenchCheck("rig",checks[0]),true);
});
