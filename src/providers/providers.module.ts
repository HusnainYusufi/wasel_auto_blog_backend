import { Module } from '@nestjs/common';
import { MinimaxModule } from '../minimax/minimax.module';
import { GeminiModule } from '../gemini/gemini.module';
import { TextProviderRegistry } from './text-provider.registry';
import { ImageProviderRegistry } from './image-provider.registry';

@Module({
  imports: [MinimaxModule, GeminiModule],
  providers: [TextProviderRegistry, ImageProviderRegistry],
  exports: [TextProviderRegistry, ImageProviderRegistry, MinimaxModule, GeminiModule],
})
export class ProvidersModule {}
