import { Module } from '@nestjs/common';
import { MinimaxModule } from '../minimax/minimax.module';
import { GeminiModule } from '../gemini/gemini.module';
import { TextProviderRegistry } from './text-provider.registry';

@Module({
  imports: [MinimaxModule, GeminiModule],
  providers: [TextProviderRegistry],
  exports: [TextProviderRegistry, MinimaxModule, GeminiModule],
})
export class ProvidersModule {}
