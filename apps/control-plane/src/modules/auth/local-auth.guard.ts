import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException, Controller, Post, Req, Res } from '@nestjs/common';
import { timingSafeEqual, createHmac } from 'node:crypto';
import type { Request, Response } from 'express';
import { CredentialStore } from '../credentials/credential-store';

export function tokenMatches(actual: string, expected: string) {
  return !!actual && !!expected && Buffer.byteLength(actual) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
export function isLocalOrigin(origin: string | undefined, allowed: string) {
  return !origin || origin === allowed;
}
@Injectable()
export class LocalAuthGuard implements CanActivate {
  constructor(private readonly credentials: CredentialStore) {}
  canActivate(context: ExecutionContext) {
    const req = context.switchToHttp().getRequest<Request>();
    if (req.path === '/api/health' || req.path === '/health') return true;
    // Existing public mock demo exposes no personal repository/credential API.
    if (process.env.ARP_PUBLIC_DEMO === 'true' && !/^\/(internal|api\/(repositories|credentials|drafts|session))/.test(req.path)) return true;
    if (req.path === '/api/github/webhook') return true; // independent HMAC verification
    const origin = process.env.ARP_WEB_ORIGIN || 'http://localhost:3000';
    if (!isLocalOrigin(req.headers.origin, origin)) throw new ForbiddenException('Untrusted browser origin');
    const access = this.credentials.accessToken();
    const bearer = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    const worker = createHmac('sha256', access).update('arp-worker').digest('hex');
    if (req.path.startsWith('/internal/')) {
      if (!tokenMatches(bearer, worker)) throw new UnauthorizedException('Worker authorization required');
      return true;
    }
    const cookie = req.headers.cookie?.split(';').map((s) => s.trim()).find((s) => s.startsWith('arp_session='))?.slice(12) ?? '';
    if (!tokenMatches(bearer, access) && !tokenMatches(cookie, access)) throw new UnauthorizedException('Local access token required');
    return true;
  }
}
@Controller('api/session')
export class SessionController {
  constructor(private readonly credentials: CredentialStore) {}
  @Post() login(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    if (!tokenMatches(req.headers.authorization?.replace(/^Bearer /, '') ?? '', this.credentials.accessToken())) throw new UnauthorizedException();
    res.cookie('arp_session', this.credentials.accessToken(), { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 86400000 });
    return { authenticated: true };
  }
}
