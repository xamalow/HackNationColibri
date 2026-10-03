// Very common Swahili words (function words, pronouns, frequent verbs/nouns), written from general
// knowledge by the Max lane (non-native, UNREVIEWED). Not derived from any dataset.
// Used by detect_language.mjs: genuine Swahili text is dense in these words; Bantu look-alikes
// (Kamba, Chichewa, Kinyarwanda...) share morphology but far fewer of these exact words.

export const SWAHILI_COMMON = new Set(`
na ya wa kwa ni za la cha vya katika kama lakini pia sana hii hiyo huu huo hizi hizo hao hawa huyu yule ile
kuwa kuna kulikuwa ilikuwa alikuwa walikuwa tulikuwa nilikuwa yeye wao sisi mimi wewe ninyi nyinyi
au ama bali tu tena hata hadi mpaka kutoka kati juu chini ndani nje mbele nyuma karibu mbali baada kabla
wakati sasa leo jana kesho siku mwaka mwezi wiki saa asubuhi mchana jioni usiku
moja mbili tatu nne tano sita saba nane tisa kumi mia elfu
kila wote yote zote kitu vitu mtu watu mwanamke wanawake mtoto watoto nyumba nchi mji kijiji serikali
kubwa ndogo nzuri mbaya mpya zamani nyingi wengi kidogo zaidi bila pamoja kwamba ili kwani
ndiyo hapana sawa asante karibu habari jambo pole tafadhali samahani
sema alisema walisema anasema wanasema kusema fanya kufanya alifanya kazi kwenda kuja kuona kujua kupata
kutumia kuhusu kuanzia kufikia mara wengine mengine nyingine kingine jinsi gani nini nani wapi lini
hapa pale huko kule humo mahali njia maji chakula kahawa shamba wageni mgeni safari bei pesa
ana wana tuna nina una mna alikuwa amekuwa imekuwa zilikuwa haikuwa hakuna hawana hana hatuna sina
`.trim().split(/\s+/));
