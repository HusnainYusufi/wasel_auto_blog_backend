import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
} from '@nestjs/common';
import { KeywordSetsService } from './keyword-sets.service';
import {
  CreateKeywordSetDto,
  UpdateKeywordSetDto,
} from './dto/keyword-set.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Roles } from '../auth/decorators/roles.decorator';

@Controller('keyword-sets')
export class KeywordSetsController {
  constructor(private readonly keywordSets: KeywordSetsService) {}

  @Get()
  findAll() {
    return this.keywordSets.findAll();
  }

  @Post()
  create(
    @Body() dto: CreateKeywordSetDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.keywordSets.create(dto, userId);
  }

  @Get(':id')
  findOne(@Param('id') id: string) {
    return this.keywordSets.findOne(id);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateKeywordSetDto) {
    return this.keywordSets.update(id, dto);
  }

  @Roles('admin')
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.keywordSets.remove(id);
  }
}
