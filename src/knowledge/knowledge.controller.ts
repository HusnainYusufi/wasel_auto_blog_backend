import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { AddSourcesDto } from './dto/add-sources.dto';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly knowledge: KnowledgeService) {}

  @Get()
  list() {
    return this.knowledge.list();
  }

  @Post()
  add(@Body() dto: AddSourcesDto) {
    return this.knowledge.addSources(dto);
  }

  @Get('profile')
  profile() {
    return this.knowledge.getProfile();
  }

  @Post('profile/rebuild')
  rebuild() {
    return this.knowledge.rebuildProfile();
  }

  @Post(':id/recrawl')
  recrawl(@Param('id') id: string) {
    return this.knowledge.recrawl(id);
  }

  @Roles('admin')
  @Delete('all')
  clear() {
    return this.knowledge.clear();
  }

  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.knowledge.remove(id);
  }
}
