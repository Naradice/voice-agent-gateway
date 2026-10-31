package dev.vag.core

import java.text.Normalizer

sealed interface Choice {
    data class Pick(val index: Int) : Choice
    data object Cancel : Choice
    data object Unknown : Choice
}

private val CANCEL = listOf("キャンセル", "きゃんせる", "やめ", "止め", "中止", "取り消", "取消", "いいえ", "イイエ", "違う", "ちがう", "やっぱり", "なし", "無し", "送らない")
private val AFFIRM = listOf("はい", "ハイ", "うん", "お願い", "おねがい", "いいよ", "いいです", "送って", "オッケー", "おっけー", "ok", "大丈夫", "それで")
private val NUMBERS = mapOf(
    "1" to 1, "2" to 2, "3" to 3, "4" to 4, "5" to 5, "6" to 6, "7" to 7, "8" to 8, "9" to 9,
    "一" to 1, "二" to 2, "三" to 3, "四" to 4, "五" to 5, "六" to 6, "七" to 7, "八" to 8, "九" to 9,
    "いち" to 1, "に" to 2, "さん" to 3, "よん" to 4, "し" to 4, "ご" to 5, "ろく" to 6, "なな" to 7, "はち" to 8, "きゅう" to 9,
    "ひとつ" to 1, "ふたつ" to 2, "みっつ" to 3, "よっつ" to 4, "いつつ" to 5,
)
private val ORDINAL_SUFFIX = Regex("(番目|番|つめ|つ目|個目|ばん|こめ)?(の|です|で|を|お願い|おねがい|します|ください)*$")

/**
 * 確認要求への音声での回答を解釈する。「2番」「にばん」「二つ目」「最初」「最後」「はい」「キャンセル」など。
 * 曖昧なものは Unknown にして聞き直す(誤って選ばない)。
 */
fun parseChoice(raw: String, count: Int): Choice {
    val t = Normalizer.normalize(raw, Normalizer.Form.NFKC).lowercase().replace(Regex("[\\s、。,.!！?？「」]"), "")
    if (t.isEmpty()) return Choice.Unknown
    if (CANCEL.any { t.contains(it.lowercase()) }) return Choice.Cancel

    // 数字・漢数字・ひらがな(+ 番/つ目 など)。文全体がこの形のときだけ採用する。
    // 「ふたつめ」は「つめ」を削ると「ふた」になってしまうため、「め」「目」だけを削る形も試す。
    val n = listOf(t.replace(ORDINAL_SUFFIX, ""), t.removeSuffix("め").removeSuffix("目")).firstNotNullOfOrNull { NUMBERS[it] }
    if (n != null) return if (n in 1..count) Choice.Pick(n - 1) else Choice.Unknown
    if (Regex("^(最初|はじめ|一番目|先頭|前者|上)(の|です|やつ|方|ほう|で|お願い)*$").matches(t)) return Choice.Pick(0)
    if (Regex("^(最後|ラスト|後者|下)(の|です|やつ|方|ほう|で|お願い)*$").matches(t)) return Choice.Pick(count - 1)

    if (count == 1 && AFFIRM.any { t.contains(it.lowercase()) }) return Choice.Pick(0)
    return Choice.Unknown
}
