// Compatibility re-export. M6 owns the assembler in src/evidence/report.ts.
export {
  assembleReport,
  assembleReport as buildRunReport,
  type AssembleReportInput,
  type AssembleReportInput as RunReportInput,
  type CostCall,
  type Warning,
} from "../evidence/report.js";
