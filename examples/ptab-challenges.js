// PTAB: every AIA trial (IPR/PGR/CBM) filed against one patent, then the decisions in the
// first trial. Calls run one at a time per API key, so keep the fan-out small.
const patentNumber = '10169987';
const trials = await odp.ptab.proceedings.search({
  q: `patentOwnerData.patentNumber:${patentNumber}`,
  fields: ['trialNumber', 'trialMetaData.trialTypeCode', 'trialMetaData.trialStatusCategory', 'trialMetaData.petitionFilingDate', 'regularPetitionerData.realPartyInInterestName'],
  limit: 50,
});
const list = trials.patentTrialProceedingDataBag ?? [];
const first = list[0]?.trialNumber;
const decisions = first ? await odp.ptab.decisions.byTrial(first) : { patentTrialDocumentDataBag: [] };
return {
  trials: list.map(t => ({ trial: t.trialNumber, type: t.trialMetaData?.trialTypeCode, status: t.trialMetaData?.trialStatusCategory, petitioner: t.regularPetitionerData?.realPartyInInterestName })),
  firstTrialDecisions: (decisions.patentTrialDocumentDataBag ?? []).map(d => ({
    date: d.decisionData?.decisionIssueDate,
    type: d.decisionData?.decisionTypeCategory,
    outcome: d.decisionData?.trialOutcomeCategory,
    title: d.documentData?.documentTitleText,
  })),
};
