import type { ThemeImportErrorCode } from '../../shared/ipc'

const en = {
  ribbonImportTheme: 'Import from PPTX',
  ribbonImportThemeTip: 'Preview colors and fonts from another PowerPoint presentation',
  themeImportTitle: 'Import presentation design',
  themeImportScope:
    'Colors and fonts apply across the destination, and explicitly colored elements may change. Slides, layouts, masters, artwork, and content are not imported. The source PPTX stays unchanged, and you can Undo.',
  themeImportMultiWarning:
    'This presentation uses multiple designs. One selected design will be applied to every slide.',
  themeImportDesign: 'Design',
  themeImportSlideCount: '{count} slides',
  themeImportHeadingFont: 'Heading font',
  themeImportBodyFont: 'Body font',
  themeImportCancel: 'Cancel',
  themeImportApply: 'Apply design',
  themeImportApplying: 'Applying…',
  themeImportApplyFailed: 'The design could not be applied.',
  themeImportPreviewFailed: 'Could not inspect the presentation.',
  themeImportPickAgain: 'Cancel and choose the source again.',
  themeImportLoading: 'Inspecting presentation design…',
  themeImportErrorUnavailable: 'Design import is unavailable while another edit is active.',
  themeImportErrorSameFile: 'Choose a presentation other than the one you are editing.',
  themeImportErrorInvalidFile: 'Choose a valid, non-empty .pptx presentation.',
  themeImportErrorTooLarge: 'The presentation is larger than 100 MiB.',
  themeImportErrorUnsupportedFile: 'Legacy or encrypted presentations are not supported.',
  themeImportErrorInspectionFailed: 'This presentation design could not be inspected safely.',
  themeImportErrorExpired: 'This design preview expired. Choose the source again.',
  themeImportErrorInvalidSelection: 'The selected design is unavailable.',
  themeImportErrorApplyFailed: 'The design could not be applied. The presentation was restored.',
}

export function themeImportErrorKey(code: ThemeImportErrorCode) {
  switch (code) {
    case 'unavailable':
      return 'themeImportErrorUnavailable' as const
    case 'same-file':
      return 'themeImportErrorSameFile' as const
    case 'invalid-file':
      return 'themeImportErrorInvalidFile' as const
    case 'too-large':
      return 'themeImportErrorTooLarge' as const
    case 'unsupported-file':
      return 'themeImportErrorUnsupportedFile' as const
    case 'expired':
      return 'themeImportErrorExpired' as const
    case 'invalid-selection':
      return 'themeImportErrorInvalidSelection' as const
    case 'apply-failed':
      return 'themeImportErrorApplyFailed' as const
    default:
      return 'themeImportErrorInspectionFailed' as const
  }
}

export const importStrings = {
  zh: {
    ...en,
    ribbonImportTheme: '从 PPTX 导入',
    ribbonImportThemeTip: '预览另一份 PowerPoint 演示文稿中的颜色和字体',
    themeImportTitle: '导入演示文稿设计',
    themeImportScope:
      '颜色和字体将应用到整个目标演示文稿，手动指定的元素颜色也可能改变。不会导入幻灯片、版式、母版、插图或内容。源 PPTX 不会更改，并且可以撤销。',
    themeImportMultiWarning: '此演示文稿使用多个设计。所选设计将应用到所有幻灯片。',
    themeImportDesign: '设计',
    themeImportSlideCount: '{count} 张幻灯片',
    themeImportHeadingFont: '标题字体',
    themeImportBodyFont: '正文字体',
    themeImportCancel: '取消',
    themeImportApply: '应用设计',
    themeImportApplying: '正在应用…',
    themeImportApplyFailed: '无法应用此设计。',
    themeImportPreviewFailed: '无法检查此演示文稿。',
    themeImportPickAgain: '取消后重新选择源文件。',
    themeImportLoading: '正在检查演示文稿设计…',
    themeImportErrorUnavailable: '其他编辑正在进行时无法导入设计。',
    themeImportErrorSameFile: '请选择当前编辑文件以外的演示文稿。',
    themeImportErrorInvalidFile: '请选择有效且非空的 .pptx 演示文稿。',
    themeImportErrorTooLarge: '演示文稿大于 100 MiB。',
    themeImportErrorUnsupportedFile: '不支持旧格式或加密的演示文稿。',
    themeImportErrorInspectionFailed: '无法安全检查此演示文稿的设计。',
    themeImportErrorExpired: '此设计预览已过期，请重新选择源文件。',
    themeImportErrorInvalidSelection: '所选设计不可用。',
    themeImportErrorApplyFailed: '无法应用此设计，演示文稿已恢复。',
  },
  en,
  ja: en,
  ko: {
    ...en,
    ribbonImportTheme: 'PPTX에서 가져오기',
    ribbonImportThemeTip: '다른 PowerPoint 프레젠테이션의 색상과 글꼴 미리보기',
    themeImportTitle: '프레젠테이션 디자인 가져오기',
    themeImportScope:
      '색상과 글꼴을 대상 전체에 적용하며 직접 지정한 요소 색상도 바뀔 수 있습니다. 슬라이드, 레이아웃, 마스터, 배경 그림 및 콘텐츠는 가져오지 않습니다. 원본 PPTX는 변경하지 않으며 실행 취소할 수 있습니다.',
    themeImportMultiWarning:
      '이 프레젠테이션에는 여러 디자인이 있습니다. 선택한 디자인 하나를 모든 슬라이드에 적용합니다.',
    themeImportDesign: '디자인',
    themeImportSlideCount: '{count}개 슬라이드',
    themeImportHeadingFont: '제목 글꼴',
    themeImportBodyFont: '본문 글꼴',
    themeImportCancel: '취소',
    themeImportApply: '디자인 적용',
    themeImportApplying: '적용 중…',
    themeImportApplyFailed: '디자인을 적용하지 못했습니다.',
    themeImportPreviewFailed: '프레젠테이션을 검사하지 못했습니다.',
    themeImportPickAgain: '취소한 뒤 원본 파일을 다시 선택하세요.',
    themeImportLoading: '프레젠테이션 디자인 검사 중…',
    themeImportErrorUnavailable: '다른 편집 작업 중에는 디자인을 가져올 수 없습니다.',
    themeImportErrorSameFile: '현재 편집 중인 파일이 아닌 프레젠테이션을 선택하세요.',
    themeImportErrorInvalidFile: '비어 있지 않은 올바른 .pptx 프레젠테이션을 선택하세요.',
    themeImportErrorTooLarge: '프레젠테이션이 100 MiB보다 큽니다.',
    themeImportErrorUnsupportedFile: '레거시 또는 암호화된 프레젠테이션은 지원하지 않습니다.',
    themeImportErrorInspectionFailed: '이 프레젠테이션의 디자인을 안전하게 검사하지 못했습니다.',
    themeImportErrorExpired: '디자인 미리보기가 만료되었습니다. 원본을 다시 선택하세요.',
    themeImportErrorInvalidSelection: '선택한 디자인을 사용할 수 없습니다.',
    themeImportErrorApplyFailed: '디자인을 적용하지 못해 프레젠테이션을 원래대로 복구했습니다.',
  },
  fr: en,
  de: en,
  es: en,
  th: en,
  id: en,
  ru: en,
  ar: en,
  pt: en,
  it: en,
  pl: en,
  nl: en,
  ms: en,
  he: en,
  hi: en,
  'zh-TW': en,
} as const
