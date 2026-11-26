// Patent File Wrapper: an applicant's recent granted utility patents, newest first, with
// only the fields needed (full records are large), plus a count of the returned patents by status.
const applicant = 'PolyPlus Battery Company';
const r = await odp.patents.search({
  q: `applicationMetaData.firstApplicantName:"${applicant}"`,
  filters: { 'applicationMetaData.applicationTypeLabelName': 'Utility' },
  rangeFilters: { 'applicationMetaData.grantDate': ['2020-01-01', '2026-12-31'] },
  sort: 'applicationMetaData.grantDate desc',
  fields: [
    'applicationNumberText',
    'applicationMetaData.inventionTitle',
    'applicationMetaData.patentNumber',
    'applicationMetaData.grantDate',
    'applicationMetaData.applicationStatusDescriptionText',
  ],
  limit: 25,
});
const records = r.patentFileWrapperDataBag ?? [];
const byStatus = {};
for (const p of records) {
  const status = p.applicationMetaData?.applicationStatusDescriptionText ?? 'Unknown';
  byStatus[status] = (byStatus[status] ?? 0) + 1;
}
return {
  total: r.count,
  patents: records.map(p => ({
    application: p.applicationNumberText,
    patent: p.applicationMetaData?.patentNumber,
    granted: p.applicationMetaData?.grantDate,
    title: p.applicationMetaData?.inventionTitle,
  })),
  byStatus,
};
