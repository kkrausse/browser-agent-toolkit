//! Syntax tree of the shell language.
use std::cell::RefCell;
use std::rc::Rc;

#[derive(Clone, Debug)]
pub enum Part {
    /// Unquoted text: subject to brace, tilde and pathname expansion.
    Lit(String),
    /// Text that is quoted (single quotes, backslash, `$'…'`, or literal text inside double quotes).
    Quoted(String),
    /// `"…"`.
    Dq(Vec<Part>),
    Param(Box<Param>),
    /// `$(…)` or backticks.
    CmdSub(Rc<Cmd>),
    /// `$((…))`: the text, itself expanded before evaluation.
    Arith(Word),
    /// `<(…)` (false) or `>(…)` (true): the name of a file standing for the command's output or input.
    ProcSub(Rc<Cmd>, bool),
}

pub type Word = Vec<Part>;

#[derive(Clone, Debug)]
pub struct Param {
    pub name: String,
    pub op: ParamOp,
    /// `${name[…]}`: the subscript (`@`, `*`, an expression or a key).
    pub index: Option<Word>,
    /// `${!name}` (the variable it names) and `${!name[@]}` (the keys).
    pub bang: bool,
}

#[derive(Clone, Debug)]
pub enum ParamOp {
    Plain,
    /// `${#x}`
    Len,
    /// `${x-w}` `${x:-w}` `${x=w}` `${x+w}` `${x?w}`: kind is one of `-=+?`.
    Default { colon: bool, kind: u8, word: Word },
    /// `${x#p}` `${x##p}` `${x%p}` `${x%%p}`
    Trim { suffix: bool, longest: bool, pat: Word },
    /// `${x/p/r}` `${x//p/r}`
    Subst { all: bool, pat: Word, rep: Word },
    /// `${x:off}` `${x:off:len}`
    Slice { off: Word, len: Option<Word> },
    /// `${x^^}` `${x,,}` `${x^}` `${x,}`
    Case { upper: bool, all: bool },
}

#[derive(Clone, Debug, PartialEq)]
pub enum RedirOp {
    In,
    Out,
    Append,
    InOut,
    DupIn,
    DupOut,
    /// `&>` and `&>>`
    OutErr { append: bool },
    HereDoc,
    HereStr,
}

#[derive(Clone, Debug)]
pub struct Redir {
    pub fd: Option<i32>,
    pub op: RedirOp,
    /// File name, descriptor number, here-string; unused for a here-document.
    pub target: Word,
    /// Here-document body, filled in when the parser reaches the lines after the command.
    pub body: Rc<RefCell<Word>>,
}

#[derive(Clone, Debug)]
pub struct Assign {
    pub name: String,
    pub append: bool,
    pub value: Word,
    /// `name[…]=value`
    pub index: Option<Word>,
    /// `name=(…)`
    pub array: Option<Vec<Word>>,
}

#[derive(Clone, Debug)]
pub enum CondTok {
    Op(String),
    W(Word),
}

#[derive(Clone, Debug)]
pub enum Cmd {
    Simple { assigns: Vec<Assign>, words: Vec<Word>, redirs: Vec<Redir> },
    Pipeline { negate: bool, cmds: Vec<Cmd> },
    /// `a && b || c`: (true = `&&`, command)
    AndOr { first: Box<Cmd>, rest: Vec<(bool, Cmd)> },
    /// (command, run in background)
    List(Vec<(Cmd, bool)>),
    Group(Box<Cmd>, Vec<Redir>),
    Subshell(Box<Cmd>, Vec<Redir>),
    If { clauses: Vec<(Cmd, Cmd)>, otherwise: Option<Box<Cmd>>, redirs: Vec<Redir> },
    For { var: String, words: Option<Vec<Word>>, body: Box<Cmd>, redirs: Vec<Redir> },
    ForArith { init: Word, cond: Word, step: Word, body: Box<Cmd>, redirs: Vec<Redir> },
    While { until: bool, cond: Box<Cmd>, body: Box<Cmd>, redirs: Vec<Redir> },
    Case { word: Word, arms: Vec<(Vec<Word>, Cmd)>, redirs: Vec<Redir> },
    FuncDef { name: String, body: Rc<Cmd> },
    /// `[[ … ]]`
    Cond(Vec<CondTok>),
    /// `(( … ))`
    Arith(Word),
}
