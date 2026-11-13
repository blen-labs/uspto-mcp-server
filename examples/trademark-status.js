// TSDR: status of a few trademark applications in one request (multiStatus takes up to 25).
const r = await tsdr.multiStatus('sn', ['97123456', '97123457']);
const marks = (r.transactionList ?? []).flatMap(t => t.trademarks ?? []);
return marks.map(t => ({
  serial: t.status?.serialNumber,
  mark: t.status?.markElement,
  status: t.status?.tm5StatusDesc,
  filed: t.status?.filingDate,
  registration: t.status?.usRegistrationNumber || null,
  classes: (t.gsList ?? []).map(g => g.primeClassCode),
}));
