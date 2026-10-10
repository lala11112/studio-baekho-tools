import {test} from "node:test";
import assert from "node:assert/strict";
import {blocksWorkbenchCheck,normalizeWorkbenchChecks,workbenchWarningMessages} from "../shared/workbench-checks";

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
