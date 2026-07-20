import { compileWorkflow, createSolutionAnalysisDraft } from './index.js';

process.stdout.write(compileWorkflow(createSolutionAnalysisDraft()).hash);
