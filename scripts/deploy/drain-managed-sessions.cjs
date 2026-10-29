'use strict';
// Re-read after each batch: a queued turn can begin while the previous batch stops.
async function drainManagedSessions({list,interrupt,record,maxBatches=20}) {
 const observed=new Map();
 for(let batch=0;batch<maxBatches;batch++){
  const rows=await list();
  for(const row of rows)observed.set(row.sessionId,row);
  record([...observed.values()]);
  if(!rows.length)return;
  for(const row of rows)await interrupt(row);
 }
 throw Error('Managed sessions keep restarting during forced deployment');
}
module.exports={drainManagedSessions};
