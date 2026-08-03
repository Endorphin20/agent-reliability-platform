import { Controller, Get } from '@nestjs/common';
import { FixtureRegistry } from './fixture-registry';

@Controller('api/fixtures')
export class FixtureController {
  constructor(private readonly fixtures: FixtureRegistry) {}

  @Get()
  list() {
    return this.fixtures.list().map((f) => ({
      id: f.id,
      title: f.title,
      category: f.category,
      description: f.taskSpec.description,
    }));
  }
}
