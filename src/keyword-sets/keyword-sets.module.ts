import { Module } from '@nestjs/common';
import { KeywordSetsController } from './keyword-sets.controller';
import { KeywordSetsService } from './keyword-sets.service';

@Module({
  controllers: [KeywordSetsController],
  providers: [KeywordSetsService],
  exports: [KeywordSetsService],
})
export class KeywordSetsModule {}
