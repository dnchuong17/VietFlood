// A synthetic provider smoke test. Never loads citizen reports or mutates the database.
const { StructuredModelClient } = require('../shared/structured-model');
const { SUMMARY_SCHEMA, SUMMARY_INSTRUCTION, renderSummary } = require('../dist/apps/reports-service/incidents/incident-summary');
const logger = { setServiceName() {}, info() {}, warn() {} };
async function main() {
  const facts=[
    {id:'1:1:0',reportId:1,revision:1,kind:'condition',text:'Đường ngập 50 cm.',reportedAt:'2026-11-01T10:00:00Z',provenance:'citizen_reported'},
    {id:'2:1:0',reportId:2,revision:1,kind:'emergency',text:'Có người mắc kẹt trong nhà ngập, cần cứu hộ.',reportedAt:'2026-11-01T10:10:00Z',provenance:'citizen_reported'},
  ];
  const model=new StructuredModelClient(logger,()=> 'synthetic-incident-smoke');
  const selection=await model.structured(SUMMARY_INSTRUCTION,{facts,emergency:true,blockedRoad:false},SUMMARY_SCHEMA,AbortSignal.timeout(45000));
  const summary=renderSummary(selection,{ward:'Địa điểm kiểm thử',address:'Dữ liệu tổng hợp, không phải sự cố thực tế',first_reported_at:facts[0].reportedAt,latest_reported_at:facts[1].reportedAt,evidence_version:1},[{emergency:false,result:{}},{emergency:true,result:{strandedPeople:true}}],facts);
  if(summary.totalReports!==2||summary.strandedPeopleReports!==1||summary.suggestedSeverity.value==='CRITICAL')throw new Error('summary_contract_failed');
  console.log(JSON.stringify({providerResponseValidated:true,totalReports:summary.totalReports,groundedConditions:summary.conditions.length,recommendations:summary.recommendations.length,automaticDeployment:false}));
}
main().catch(error=>{console.error(JSON.stringify({passed:false,reason:typeof error.reason==='string'&&/^[a-z0-9_]+$/.test(error.reason)?error.reason:'incident_summary_check_failed'}));process.exitCode=1;});
