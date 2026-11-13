import { HttpClient } from '../util/httpClient.js';

/**
 * TSDR case id: 'sn' + 8-digit serial number, 'rn' + registration number (up to 8 digits),
 * 'ref' + Madrid reference number (letters and digits, e.g. 'refZ1231384'), or 'ir' + international
 * registration number. A bare 8-digit number is treated as a serial number, 7 or fewer digits as a
 * registration number. The prefix is case-insensitive; a reference number keeps its case.
 */
export function normalizeCaseId(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new TypeError('caseId must be a string');
  const v = String(value).trim().replace(/[\s,]/g, '');
  let m: RegExpExecArray | null;
  if ((m = /^sn(\d{8})$/i.exec(v))) return `sn${m[1]}`;
  if ((m = /^rn(\d{1,8})$/i.exec(v))) return `rn${m[1]!.padStart(7, '0')}`;
  if ((m = /^ir(\d{1,10})$/i.exec(v))) return `ir${m[1]}`;
  if ((m = /^ref([A-Za-z0-9]{1,20})$/i.exec(v))) return `ref${m[1]}`;
  if (/^\d{8}$/.test(v)) return `sn${v}`;
  if (/^\d{1,7}$/.test(v)) return `rn${v.padStart(7, '0')}`;
  throw new TypeError(`Unrecognized trademark case id '${String(value).slice(0, 50)}'. Use 'sn' + serial number (e.g. 'sn97123456'), 'rn' + registration number (e.g. 'rn6123456'), 'ref' + Madrid reference number, or 'ir' + international registration number.`);
}

const MULTI_TYPES = new Set(['sn', 'rn', 'ref', 'ir']);

/** Trademark Status & Document Retrieval (tsdrapi.uspto.gov). Separate key from ODP. */
export class TsdrClient {
  constructor(private readonly http: HttpClient) {}

  /** Case status and bibliographic data (marks, owners, goods & services, prosecution events) as JSON. */
  status = (caseId: string) =>
    this.http.call({ path: `/ts/cd/casestatus/${normalizeCaseId(caseId)}/info`, accept: 'json' });

  /** Status for up to 25 cases of one number type ('sn' | 'rn' | 'ref' | 'ir') in one call. */
  multiStatus = (type: string, ids: string[]) => {
    if (!MULTI_TYPES.has(type)) throw new TypeError("type must be one of 'sn', 'rn', 'ref', 'ir'");
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 25) throw new RangeError('ids must be an array of 1 to 25 numbers');
    const clean = ids.map(id => {
      const s = String(id).trim().replace(/[\s,]/g, '');
      if (!/^[A-Za-z0-9]{1,20}$/.test(s)) throw new TypeError(`Invalid id '${id}'`);
      return s;
    });
    return this.http.call({ path: `/ts/cd/caseMultiStatus/${type}`, query: { ids: clean.join(',') }, accept: 'json' });
  };

  /** The case's document list (metadata for each filing, office action, etc.) as XML text. */
  documents = (caseId: string) =>
    this.http.call({ path: `/ts/cd/casedocs/${normalizeCaseId(caseId)}/info`, accept: 'xml' });

  /** Metadata for one document in a case, as XML text. */
  documentInfo = (caseId: string, documentId: string) => {
    if (typeof documentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(documentId)) throw new TypeError('documentId must be a TSDR document id');
    return this.http.call({ path: `/ts/cd/casedoc/${normalizeCaseId(caseId)}/${documentId}/info`, accept: 'xml' });
  };

  /** When the case's prosecution history last changed. Serial numbers only. */
  lastUpdate = (serialNumber: string) => {
    const sn = String(serialNumber ?? '').trim().toLowerCase().replace(/^sn/, '');
    if (!/^\d{8}$/.test(sn)) throw new TypeError('serialNumber must be an 8-digit trademark serial number');
    return this.http.call({ path: '/last-update/info.json', query: { sn }, accept: 'json' });
  };
}
