export interface AuditAdvisory {
  github_advisory_id?: string;
  module_name?: string;
  patched_versions?: string;
}

export interface AuditReport {
  advisories?: Record<string, AuditAdvisory>;
}

export declare function splitAuditConfig(yamlText: string): { ghsas: string[]; rest: string };
export declare function staleExceptions(ghsas: string[], audit: AuditReport): string[];
