'use strict';
/** Sidebar liveness also includes independent CLIs. Deployment owns live turns and tracked background tasks. */
function partitionDeploymentSessions(rows) {
  const managed=[],independent=[];
  for(const row of rows){
    const independentCli=row.canInterrupt===false && !row.tasks?.length && ['Running in the Claude CLI','Recovered CLI process; force stop is available'].includes(row.statusText);
    (independentCli?independent:managed).push(row);
  }
  return {managed,independent};
}
module.exports={partitionDeploymentSessions};
