import { Controller, Get } from '@nestjs/common';
import { MinimaxService } from '../minimax/minimax.service';
import { TextProviderRegistry } from '../providers/text-provider.registry';
import { Public } from '../auth/decorators/public.decorator';

@Controller()
export class HealthController {
  constructor(
    private readonly minimax: MinimaxService,
    private readonly textProviders: TextProviderRegistry,
  ) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'wasel-auto-blog-backend',
      minimaxConfigured: this.minimax.isConfigured,
      textProviders: this.textProviders.list().map((p) => ({
        id: p.id,
        configured: p.isConfigured,
      })),
      imageModel: this.minimax.defaultImageModel,
      timestamp: new Date().toISOString(),
    };
  }
}
