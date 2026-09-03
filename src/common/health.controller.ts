import { Controller, Get } from '@nestjs/common';
import { MinimaxService } from '../minimax/minimax.service';
import { Public } from '../auth/decorators/public.decorator';

@Controller()
export class HealthController {
  constructor(private readonly minimax: MinimaxService) {}

  @Public()
  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'wasel-auto-blog-backend',
      minimaxConfigured: this.minimax.isConfigured,
      textModel: this.minimax.defaultTextModel,
      imageModel: this.minimax.defaultImageModel,
      timestamp: new Date().toISOString(),
    };
  }
}
