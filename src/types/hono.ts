import type { JwtPayload } from '../lib/jwt';

export interface AppVariables {
  user: JwtPayload;
}
