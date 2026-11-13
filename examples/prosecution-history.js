// One application's prosecution story: resolve a patent number, then pull its office
// actions (current Office Action Search API) and the rejection grounds raised in each.
const found = await odp.patents.byPatentNumber('11,646,472', { fields: ['applicationNumberText', 'applicationMetaData.inventionTitle'] });
const app = found.patentFileWrapperDataBag?.[0];
if (!app) return { error: 'patent not found' };
const actions = await odp.officeActions.search({
  q: `applicationNumberText:${app.applicationNumberText}`,
  fields: ['officeActionRecordIdentifier', 'documentCode', 'documentCodeDescriptionText', 'submissionDate', 'rejectionTypeBag'],
  sort: 'submissionDate asc',
  limit: 50,
});
return {
  application: app.applicationNumberText,
  title: app.applicationMetaData?.inventionTitle,
  officeActions: (actions.officeActionDataBag ?? []).map(a => ({
    date: a.submissionDate, code: a.documentCode, what: a.documentCodeDescriptionText, grounds: a.rejectionTypeBag,
  })),
};
