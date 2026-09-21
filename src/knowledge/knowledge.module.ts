import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { ProvidersModule } from '../providers/providers.module';

@Module({
  imports: [ProvidersModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService],
  exports: [KnowledgeService],
})
export class KnowledgeModule {}
