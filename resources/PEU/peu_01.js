// 普洱学院(peu.edu.cn) 拾光课程表适配脚本
// 教务系统：正方教务 v9（jwxt.peu.edu.cn / 统一身份认证）
// 入口页面：https://jwxt.peu.edu.cn/jwglxt/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=N253508&layout=default
//
// 说明：
//   本脚本在用户登录后的 WebView 中执行，通过正方 v9 的 JSON 接口直接拉取课表数据，
//   不依赖页面 DOM 结构，稳定性更高。
//   非本校开发者维护，若数据有误请提交 issue / PR。

/* ============================ 基础配置 ============================ */

// 学生课表查询菜单码（PEU 为 N253508）
const GNMKDM_KB = "N253508";
// 作息/校历相关菜单码（各校可能不同，仅作 best-effort，失败不影响主流程）
const GNMKDM_JC = "N2154";

/**
 * 推导正方教务根地址（含 /jwglxt）
 * - 校园网直连：https://jwxt.peu.edu.cn -> https://jwxt.peu.edu.cn/jwglxt
 * - webvpn 代理：https://xxx.webvpn.peu.edu.cn -> 同源 + /jwglxt
 * 采用同源推导可自适应不同入口。
 */
function getBaseUrl() {
    const origin = window.location.origin;
    if (origin && /^https?:\/\//.test(origin)) {
        return origin.replace(/\/+$/, "") + "/jwglxt";
    }
    return "https://jwxt.peu.edu.cn/jwglxt";
}

/* ============================ 通用工具函数 ============================ */

/**
 * 解析周次字符串，处理范围、单双周、逗号/顿号分隔等格式
 * 例："1-16周" -> [1..16]；"1-16周(单)" -> [1,3,...,15]；"1-8,10-16周" -> [1..8,10..16]
 */
function parseWeeks(weekStr) {
    if (!weekStr) return [];

    const cleaned = String(weekStr)
        .replace(/周数[:：]/g, "")
        .replace(/第/g, "")
        .replace(/周/g, "")
        .replace(/共\s*\d+\s*.*$/g, "");

    const segments = cleaned.split(/[,，、;；]/);
    const weeks = [];
    const segRegex = /(\d+)(?:\s*[-~]\s*(\d+))?\s*(?:[（(]?\s*([单双])\s*周?\s*[)）]?)?/g;

    for (const seg of segments) {
        const s = seg.trim();
        if (!s) continue;

        segRegex.lastIndex = 0;
        let m;
        while ((m = segRegex.exec(s)) !== null) {
            if (m[0] === "") {
                segRegex.lastIndex++;
                continue;
            }

            const start = parseInt(m[1], 10);
            const end = m[2] ? parseInt(m[2], 10) : start;
            const flagStr = m[3] || "";

            let flag = 0;
            if (flagStr.includes("单")) flag = 1;
            else if (flagStr.includes("双")) flag = 2;

            for (let w = start; w <= end; w++) {
                if (flag === 1 && w % 2 === 0) continue;
                if (flag === 2 && w % 2 !== 0) continue;
                weeks.push(w);
            }
        }
    }

    return [...new Set(weeks)].sort((a, b) => a - b);
}

/**
 * 合并连续节次、去重，并合并相同节次的不同周次
 */
function mergeAndDistinctCourses(courses) {
    if (!Array.isArray(courses) || courses.length <= 1) return courses;

    const list = courses.map(c => ({
        ...c,
        name: c.name || "",
        teacher: c.teacher || "",
        position: c.position || "",
        weeks: Array.isArray(c.weeks) ? [...c.weeks].sort((a, b) => a - b) : []
    }));

    // 阶段 1：合并连续节次 / 完全重复记录
    list.sort((a, b) =>
        a.name.localeCompare(b.name) ||
        a.teacher.localeCompare(b.teacher) ||
        a.position.localeCompare(b.position) ||
        (a.day || 0) - (b.day || 0) ||
        a.weeks.join(",").localeCompare(b.weeks.join(",")) ||
        (a.startSection || 0) - (b.startSection || 0)
    );

    const step1Merged = [];
    let current = list[0];

    for (let i = 1; i < list.length; i++) {
        const next = list[i];
        const isSameCourseAndWeeks =
            current.name === next.name &&
            current.teacher === next.teacher &&
            current.position === next.position &&
            current.day === next.day &&
            current.weeks.join(",") === next.weeks.join(",");

        const isContinuous = current.endSection + 1 === next.startSection;
        const isDuplicate = current.startSection === next.startSection && current.endSection === next.endSection;

        if (isSameCourseAndWeeks && isContinuous) {
            current.endSection = next.endSection;
        } else if (isSameCourseAndWeeks && isDuplicate) {
            continue;
        } else {
            step1Merged.push(current);
            current = next;
        }
    }
    step1Merged.push(current);

    // 阶段 2：合并相同节次的周次
    step1Merged.sort((a, b) =>
        a.name.localeCompare(b.name) ||
        a.teacher.localeCompare(b.teacher) ||
        a.position.localeCompare(b.position) ||
        (a.day || 0) - (b.day || 0) ||
        (a.startSection || 0) - (b.startSection || 0) ||
        (a.endSection || 0) - (b.endSection || 0)
    );

    const step2Merged = [];
    let cur = step1Merged[0];

    for (let i = 1; i < step1Merged.length; i++) {
        const nxt = step1Merged[i];
        const isSameCourseAndSection =
            cur.name === nxt.name &&
            cur.teacher === nxt.teacher &&
            cur.position === nxt.position &&
            cur.day === nxt.day &&
            cur.startSection === nxt.startSection &&
            cur.endSection === nxt.endSection;

        if (isSameCourseAndSection) {
            cur.weeks = Array.from(new Set([...cur.weeks, ...nxt.weeks])).sort((a, b) => a - b);
        } else {
            step2Merged.push(cur);
            cur = nxt;
        }
    }
    step2Merged.push(cur);

    return step2Merged;
}

/**
 * 解析正方 v9 学生课表 JSON（kbList）
 */
function parseJsonData(jsonData) {
    if (!jsonData || !Array.isArray(jsonData.kbList)) {
        return [];
    }

    const initialCourseList = [];

    for (const rawCourse of jsonData.kbList) {
        if (!rawCourse.kcmc || !rawCourse.xqj || !rawCourse.jcs || !rawCourse.zcd) {
            continue;
        }

        const weeksArray = parseWeeks(rawCourse.zcd);
        if (weeksArray.length === 0) continue;

        const sectionParts = String(rawCourse.jcs).split("-");
        const startSection = Number(sectionParts[0]);
        const endSection = Number(sectionParts[sectionParts.length - 1]);
        const day = Number(rawCourse.xqj);

        if (isNaN(day) || isNaN(startSection) || isNaN(endSection) ||
            day < 1 || day > 7 || startSection > endSection) {
            continue;
        }

        initialCourseList.push({
            name: String(rawCourse.kcmc).trim(),
            teacher: String(rawCourse.xm || "").trim(),
            position: String(rawCourse.cdmc || "").trim(),
            day: day,
            startSection: startSection,
            endSection: endSection,
            weeks: weeksArray
        });
    }

    return mergeAndDistinctCourses(initialCourseList);
}

/* ============================ 用户交互 ============================ */

async function promptUserToStart() {
    return await window.shiguangBridgePromise.showAlert(
        "普洱学院教务课表导入",
        "导入前请确保您已成功登录正方教务系统。\n若页面停留在登录页，请先完成登录后再点击“开始导入”。",
        "好的，开始导入"
    );
}

/* ============================ 学年 / 学期 ============================ */

/**
 * 从学生课表查询首页解析学年 / 学期下拉选项
 */
async function fetchAcademicOptions() {
    const url = `${getBaseUrl()}/kbcx/xskbcx_cxXskbcxIndex.html?gnmkdm=${GNMKDM_KB}&layout=default`;

    try {
        const response = await fetch(url, {
            method: "GET",
            credentials: "include"
        });

        if (!response.ok) return null;

        const htmlText = await response.text();
        const doc = new DOMParser().parseFromString(htmlText, "text/html");

        const allYearOptions = Array.from(doc.querySelectorAll("#xnm option"))
            .filter(opt => opt.value !== "")
            .map(opt => ({ value: opt.value, text: opt.textContent.trim(), selected: opt.selected }));

        const semesterOptions = Array.from(doc.querySelectorAll("#xqm option"))
            .filter(opt => opt.value !== "")
            .map(opt => ({ value: opt.value, text: opt.textContent.trim(), selected: opt.selected }));

        if (allYearOptions.length === 0 || semesterOptions.length === 0) {
            return null;
        }

        const selectedIndex = allYearOptions.findIndex(opt => opt.selected);
        const defaultSemesterIndex = semesterOptions.findIndex(opt => opt.selected);

        if (selectedIndex === -1) {
            return {
                yearOptions: allYearOptions.slice(0, 5),
                semesterOptions,
                defaultYearIndex: 0,
                defaultSemesterIndex: defaultSemesterIndex !== -1 ? defaultSemesterIndex : 0
            };
        }

        const start = Math.max(0, selectedIndex - 2);
        const end = Math.min(allYearOptions.length, selectedIndex + 3);
        const yearOptions = allYearOptions.slice(start, end);

        return {
            yearOptions,
            semesterOptions,
            defaultYearIndex: selectedIndex - start,
            defaultSemesterIndex: defaultSemesterIndex !== -1 ? defaultSemesterIndex : 0
        };
    } catch (e) {
        return null;
    }
}

/**
 * 让用户选择学年 / 学期；解析失败时回退为手动输入
 */
async function selectAcademicYearAndSemester() {
    const optionsData = await fetchAcademicOptions();

    if (optionsData) {
        const { yearOptions, semesterOptions, defaultYearIndex, defaultSemesterIndex } = optionsData;

        const yearIndex = await window.shiguangBridgePromise.showSingleSelection(
            "选择学年",
            JSON.stringify(yearOptions.map(item => item.text)),
            defaultYearIndex
        );
        if (yearIndex === null || yearIndex === -1) return null;

        const semesterIndex = await window.shiguangBridgePromise.showSingleSelection(
            "选择学期",
            JSON.stringify(semesterOptions.map(item => item.text)),
            defaultSemesterIndex
        );
        if (semesterIndex === null || semesterIndex === -1) return null;

        return {
            academicYear: yearOptions[yearIndex].value,
            semesterCode: semesterOptions[semesterIndex].value
        };
    }

    // 回退：手动输入
    window.shiguangBridge.showToast("未能读取学年学期列表，请手动输入。");
    const yearInput = await window.shiguangBridgePromise.showPrompt(
        "输入学年",
        "例如：2025（表示 2025-2026 学年）",
        String(new Date().getFullYear())
    );
    if (yearInput === null) return null;

    const semesterIndex = await window.shiguangBridgePromise.showSingleSelection(
        "选择学期",
        JSON.stringify(["第一学期", "第二学期", "第三学期"]),
        0
    );
    if (semesterIndex === null || semesterIndex === -1) return null;

    // 正方 xqm 码：第一学期=3，第二学期=12，第三学期=16
    const semesterCodeMap = ["3", "12", "16"];

    return {
        academicYear: String(yearInput).trim(),
        semesterCode: semesterCodeMap[semesterIndex]
    };
}

/* ============================ 数据接口 ============================ */

/**
 * 请求学生课表数据。
 * 不同正方部署的数据接口命名可能略有差异，这里按优先级依次尝试。
 */
async function fetchCourseJson(academicYear, semesterCode) {
    const candidates = [
        "kbcx/xskbcx_cxXsgrkb.html",
        "kbcx/xskbcx_cxXsKb.html"
    ];
    const requestBody = `xnm=${academicYear}&xqm=${semesterCode}&kzlx=ck&xsdm=&kclbdm=`;

    for (const path of candidates) {
        const targetUrl = `${getBaseUrl()}/${path}?gnmkdm=${GNMKDM_KB}`;
        try {
            const response = await fetch(targetUrl, {
                method: "POST",
                headers: {
                    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                    "X-Requested-With": "XMLHttpRequest"
                },
                body: requestBody,
                credentials: "include"
            });

            if (!response.ok) continue;

            const text = await response.text();
            if (!text || text.trim().startsWith("<")) continue; // 返回 HTML 说明未登录/接口错误

            const json = JSON.parse(text);
            if (json && Array.isArray(json.kbList) && json.kbList.length > 0) {
                return json;
            }
        } catch (e) {
            // 尝试下一个接口
        }
    }

    return null;
}

/**
 * 获取学期开学日期（best-effort，失败返回 null）
 */
async function fetchSemesterStartDate(academicYear, semesterCode) {
    const url = `${getBaseUrl()}/kbcx/xskbcxZccx_cxZcByXnxq.html?gnmkdm=${GNMKDM_JC}`;
    const requestBody = `xnm=${academicYear}&xqm=${semesterCode}`;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "accept": "application/json, text/javascript, */*; q=0.01",
                "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest"
            },
            body: requestBody,
            credentials: "include"
        });

        if (!response.ok) return null;

        const json = await response.json();
        if (Array.isArray(json) && json.length > 0) {
            const firstWeekObj = json.find(item => String(item.zs) === "1" || String(item.zsmc) === "1") || json[0];

            if (firstWeekObj.rq) {
                const startDateStr = String(firstWeekObj.rq).split("/")[0];
                if (/^\d{4}-\d{2}-\d{2}$/.test(startDateStr)) return startDateStr;
            }
            if (firstWeekObj.zcrq) {
                const match = String(firstWeekObj.zcrq).match(/(\d{4}-\d{2}-\d{2})/);
                if (match) return match[1];
            }
            if (firstWeekObj.ksrq) {
                const match = String(firstWeekObj.ksrq).match(/(\d{4}-\d{2}-\d{2})/);
                if (match) return match[1];
            }
        }
    } catch (e) {
        // 忽略
    }
    return null;
}

/**
 * 从教务系统动态获取作息时间（节次时间）
 */
async function fetchTimeSlots(academicYear, semesterCode) {
    const url = `${getBaseUrl()}/jzgl/skxxMobile_cxRsdjc.html?gnmkdm=${GNMKDM_JC}`;
    const requestBody = `xnm=${academicYear}&xqm=${semesterCode}&xqh_id=1`;

    try {
        const response = await fetch(url, {
            method: "POST",
            headers: {
                "accept": "*/*",
                "content-type": "application/x-www-form-urlencoded;charset=UTF-8",
                "X-Requested-With": "XMLHttpRequest"
            },
            body: requestBody,
            credentials: "include"
        });

        if (!response.ok) return null;

        const json = await response.json();
        if (!Array.isArray(json)) return null;

        const timeSlots = json
            .filter(item => item.jcmc && item.qssj && item.jssj)
            .map(item => ({
                number: Number(item.jcmc),
                startTime: String(item.qssj).substring(0, 5),
                endTime: String(item.jssj).substring(0, 5)
            }))
            .filter(item => !isNaN(item.number))
            .sort((a, b) => a.number - b.number);

        return timeSlots.length > 0 ? timeSlots : null;
    } catch (e) {
        return null;
    }
}

/* ============================ 保存流程 ============================ */

async function saveCourses(parsedCourses) {
    try {
        await window.shiguangBridgePromise.saveImportedCourses(JSON.stringify(parsedCourses));
        return true;
    } catch (error) {
        window.shiguangBridge.showToast(`课程保存失败: ${error.message}`);
        return false;
    }
}

// 普洱学院作息时间表（13 节次），来自教务系统实际作息；
// 优先使用接口动态获取，获取失败时回退到此表。
const FALLBACK_TIME_SLOTS = [
    { number: 1, startTime: "08:00", endTime: "08:40" },
    { number: 2, startTime: "08:50", endTime: "09:30" },
    { number: 3, startTime: "09:50", endTime: "10:30" },
    { number: 4, startTime: "10:40", endTime: "11:20" },
    { number: 5, startTime: "11:30", endTime: "12:10" },
    { number: 6, startTime: "14:30", endTime: "15:10" },
    { number: 7, startTime: "15:20", endTime: "16:00" },
    { number: 8, startTime: "16:20", endTime: "17:00" },
    { number: 9, startTime: "17:10", endTime: "17:50" },
    { number: 10, startTime: "19:00", endTime: "19:40" },
    { number: 11, startTime: "19:50", endTime: "20:30" },
    { number: 12, startTime: "20:50", endTime: "21:30" },
    { number: 13, startTime: "21:40", endTime: "22:20" }
];

async function importPresetTimeSlots(timeSlots) {
    let finalTimeSlots = timeSlots;
    let usedFallback = false;

    if (!finalTimeSlots || finalTimeSlots.length === 0) {
        finalTimeSlots = FALLBACK_TIME_SLOTS;
        usedFallback = true;
    }

    try {
        await window.shiguangBridgePromise.savePresetTimeSlots(JSON.stringify(finalTimeSlots));
        if (usedFallback) {
            window.shiguangBridge.showToast("未获取到教务系统作息，已使用内置保底作息时间导入。");
        }
    } catch (error) {
        window.shiguangBridge.showToast("导入时间段失败: " + error.message);
    }
}

/* ============================ 主流程 ============================ */

async function runImportFlow() {
    const alertConfirmed = await promptUserToStart();
    if (!alertConfirmed) {
        window.shiguangBridge.showToast("用户取消了导入。");
        return;
    }

    const selection = await selectAcademicYearAndSemester();
    if (!selection) {
        window.shiguangBridge.showToast("未选择学年学期，导入流程终止。");
        return;
    }

    const { academicYear, semesterCode } = selection;

    // 并行获取课程数据、开学日期、作息时间
    const [courseJson, semesterStartDate, timeSlots] = await Promise.all([
        fetchCourseJson(academicYear, semesterCode),
        fetchSemesterStartDate(academicYear, semesterCode),
        fetchTimeSlots(academicYear, semesterCode)
    ]);

    if (!courseJson) {
        window.shiguangBridge.showToast("未能获取课表数据，请检查登录状态或网络环境。");
        return;
    }

    const parsedCourses = parseJsonData(courseJson);
    if (parsedCourses.length === 0) {
        window.shiguangBridge.showToast("未解析到有效课程，请确认所选学年学期是否正确。");
        return;
    }

    const saveResult = await saveCourses(parsedCourses);
    if (!saveResult) return;

    try {
        await window.shiguangBridgePromise.saveCourseConfig(JSON.stringify({
            semesterStartDate: semesterStartDate,
            semesterTotalWeeks: 20
        }));
        let configMsg = "课表配置更新成功！";
        if (semesterStartDate) configMsg += ` 开学日期：${semesterStartDate}`;
        window.shiguangBridge.showToast(configMsg);
    } catch (error) {
        window.shiguangBridge.showToast(`课表配置保存失败: ${error.message}`);
    }

    await importPresetTimeSlots(timeSlots);

    window.shiguangBridge.showToast(`课程导入成功，共导入 ${parsedCourses.length} 门课程！`);
    window.shiguangBridge.notifyTaskCompletion();
}

runImportFlow();
