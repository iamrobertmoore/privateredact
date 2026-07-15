import type { IExecuteFunctions } from 'n8n-workflow';
export interface AttestationResult {
    attestation_verified: boolean;
    processor?: string;
    nilcc_version?: string;
    measurement?: string;
    measurement_matches_known_build?: boolean | null;
    report_data?: string;
    checks?: Record<string, boolean>;
    error?: string;
}
export declare function detectProcessor(family: number, model: number): string | null;
export interface ReportedTcb {
    bootloader: number;
    tee: number;
    snp: number;
    microcode: number;
}
export declare function verifyTcbExtensions(vcekDer: Buffer, tcb: ReportedTcb, chipIdHex: string): boolean;
export declare function checkReportDataBinding(reportDataHex: string, certDer: Buffer): boolean;
export declare function verifyEnclaveAttestation(ctx: IExecuteFunctions, baseUrl: string): Promise<AttestationResult>;
