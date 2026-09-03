import { Module } from '@nestjs/common';
import { BlogController } from './blog.controller';
import { BlogService } from './blog.service';
import { MinimaxModule } from '../minimax/minimax.module';
import { StorageModule } from '../storage/storage.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [MinimaxModule, StorageModule, KnowledgeModule],
  controllers: [BlogController],
  providers: [BlogService],
})
export class BlogModule {}
