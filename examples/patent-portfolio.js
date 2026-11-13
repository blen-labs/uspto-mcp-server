// Patent File Wrapper: an applicant's recent granted utility patents, newest first, with
// only the fields needed (full records are large), plus a status breakdown via facets.
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
  facets: ['applicationMetaData.applicationStatusDescriptionText'],
  limit: 25,
});
return {
  total: r.count,
  patents: (r.patentFileWrapperDataBag ?? []).map(p => ({
    application: p.applicationNumberText,
    patent: p.applicationMetaData?.patentNumber,
    granted: p.applicationMetaData?.grantDate,
    title: p.applicationMetaData?.inventionTitle,
  })),
  byStatus: r.facets,
};
