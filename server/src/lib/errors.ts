export class AppError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}
export const badRequest = (code: string, msg: string, details?: unknown) => new AppError(400, code, msg, details);
export const unauthorized = (msg = 'Autenticação necessária.') => new AppError(401, 'UNAUTHENTICATED', msg);
export const forbidden = (msg = 'Você não tem permissão para esta ação.', code = 'FORBIDDEN') => new AppError(403, code, msg);
export const notFound = (msg = 'Registro não encontrado.') => new AppError(404, 'NOT_FOUND', msg);
export const conflict = (code: string, msg: string, details?: unknown) => new AppError(409, code, msg, details);
export const unprocessable = (code: string, msg: string, details?: unknown) => new AppError(422, code, msg, details);
