export type ResultOk<T = unknown> = { ok: true; code?: string; message?: string; data?: T };
export type ResultErr = { ok: false; code: string; message: string; data?: unknown };
export type Result<T = unknown> = ResultOk<T> | ResultErr;
