import jwt from 'jsonwebtoken';

export interface JwtPayload {
  sub: string;
  email: string;
  role: 'PM' | 'INTERNAL' | 'CLIENT';
  department?: 'UIUX' | 'FRONTEND' | 'BACKEND' | null;
}

const secret = process.env.JWT_SECRET;
if (!secret) {
  throw new Error('JWT_SECRET environment variable is not set');
}

const expiresIn = (process.env.JWT_EXPIRES_IN ?? '1d') as jwt.SignOptions['expiresIn'];

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, secret as string, { expiresIn });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, secret as string) as JwtPayload;
}
