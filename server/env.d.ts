export function loadEnv(): void;
export function getDataDir(): { dir: string; dbPath: string };
export function getJwtSecret(): string;
export function getRoomTtlMs(): number;
export function getReportRetentionMs(): number;
export function getAllowedOrigins(): string[];
