#NoEnv
#SingleInstance Force
SetWorkingDir %A_ScriptDir%

; Request admin privileges
if not A_IsAdmin
{
    Run *RunAs "%A_ScriptFullPath%"
    ExitApp
}

; Delay for startup stability
Sleep, 5

; Run the program
Run, C:\Users\alexl\Desktop\Scripts\WindowsSpyBlocker.exe

; Wait for the window
WinWait, ahk_exe WindowsSpyBlocker.exe,, 15
if ErrorLevel
{
    MsgBox, WindowsSpyBlocker window not found within 15 seconds.
    ExitApp
}

; Activate the window
WinActivate, ahk_exe WindowsSpyBlocker.exe
Sleep, 2000

; Send "1" and Enter three times
Send, 1
Sleep, 500
Send, {Enter}
Sleep, 500
Send, 1
Sleep, 500
Send, {Enter}
Sleep, 500
Send, 1
Sleep, 500
Send, {Enter}
Sleep, 5000

; Close the window
WinClose, ahk_exe WindowsSpyBlocker.exe
Sleep, 1000
if WinExist, ahk_exe WindowsSpyBlocker.exe
{
    Process, Close, WindowsSpyBlocker.exe
}

ExitApp